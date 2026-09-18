# TSyringe 知识点

> 定位：服务端依赖注入实现专题
>
> 状态：TSyringe 4.10.0，最近于 2026-09-18（Step 17）按容器实现核对

本文沉淀 TSyringe 4.10.0 的核心机制与 Clash Sentinel 服务端的使用约定。系统上下文、组件关系
和完整生命周期见[服务端设计总览](server-design.md)，实际注入类、接口和成员见
[类与接口设计](server-class-design.md)。容器行为的最终事实源是
`apps/server/src/composition/`、`application-runtime.ts` 和相应测试；依赖装配变化必须同步更新本文。

知识点来源分三层标注：

- **[README]** — 官方文档（[microsoft/tsyringe](https://github.com/microsoft/tsyringe)）明确记载
- **[源码]** — 4.10.0 实现源码（`node_modules/tsyringe/dist/cjs/`）核实，README 未明说
- **[实践]** — 本项目实测踩坑结论（STEP.md Step 16 记录）

## 一、定位与安装

TSyringe 是 Microsoft 维护的轻量依赖注入容器，面向 TypeScript 装饰器特性。

官方要求的安装配置 [README]：

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

以及在任何 DI 使用之前导入一次 `reflect-metadata`（Reflect API polyfill）。

### 本项目的差异配置 [实践]

本项目**只开 `experimentalDecorators`，不开 `emitDecoratorMetadata`**，原因有三：

1. **工具链限制**：服务端 dev 使用 tsx、测试使用 Vitest 3，均基于 esbuild 转换，esbuild 不支持 `emitDecoratorMetadata`——元数据只会出现在 tsc 生产构建里，导致依赖反射自动装配的代码在 dev 和测试环境解析失败。
2. **不需要**：显式 `@inject(token)` 按参数位置记录依赖，不读反射元数据（见第二节源码分析），关掉该选项反而保证三环境（tsc/tsx/vitest）行为一致。
3. **项目依赖结构决定自动装配不可行**：服务端大量使用 `Pick<>` 结构类型和接口（如任务 Handler 的仓储依赖、`StatusNotifier`），这些类型编译后没有运行时身份，即使 tsc 也反射不出可解析的构造函数。

其他安装事实 [实践]：

- `tsyringe` 与 `reflect-metadata` 均为 CJS 包；纯 ESM + NodeNext 下 named import 只对**运行时导出**可用（`injectable`、`inject`、`container`、`Lifecycle` 等），`DependencyContainer` 等纯类型必须 `import type`。
- 任何 tsyringe 导入之前必须已加载 `reflect-metadata`（否则包加载时直接抛错）；本项目在生产入口 `index.ts` 首行和 `vitest.config.ts` 的 `setupFiles`（`apps/server/test-support/vitest-setup.ts`）分别保证加载顺序。
- tsx 只对匹配 tsconfig `include`（`src/**/*.ts`）的文件应用装饰器编译选项，src 目录之外的脚本会拒绝参数装饰器。

## 二、注入机制原理（源码级）

### 2.1 装饰器求值时发生什么

`@injectable()` 无参数调用时的完整行为 [源码]（`decorators/injectable.js`）：

```js
function injectable(options) {
  return function (target) {
    // ① 把类的参数表写入模块级 Map（不是注册到容器！）
    dependency_container_1.typeInfo.set(target, reflection_helpers_1.getParamInfo(target));
    // ② 仅当传入 options.token 时才注册到全局容器
    if (options && options.token) { ... instance.register(options.token, target); }
  };
}
```

关键结论：**`@injectable()` 本身不注册任何东西**，它只把"构造参数表"存进模块级 `typeInfo` Map，供 `construct()` 时查询。传 `{ token }` 才会注册到全局容器——本项目不使用该形式。

### 2.2 参数表如何生成：元数据底表 + @inject 按位置覆盖

`getParamInfo()` 的合并算法 [源码]（`reflection-helpers.js`）：

```js
function getParamInfo(target) {
  // 底表：emitDecoratorMetadata 发出的 design:paramtypes；未开启时为空数组 []
  const params = Reflect.getMetadata("design:paramtypes", target) || [];
  // 覆盖表：@inject 装饰器按参数下标记录的 token
  const injectionTokens = Reflect.getOwnMetadata("injectionTokens", target) || {};
  Object.keys(injectionTokens).forEach((key) => {
    params[+key] = injectionTokens[key];
  });
  return params;
}
```

`@inject(token)` 装饰器（`defineInjectionTokenMetadata`）的实现就是把 token 写到 `injectionTokens[parameterIndex]`。这解释了三件事：

- **显式 `@inject` 与元数据无关**：不开 `emitDecoratorMetadata` 时底表是空数组，但 `@inject` 记录的 token 按下标覆盖进去，参数表照样完整——这就是本项目方案的源码依据。
- **`TypeInfo not known` 错误的成因** [实践]：某个参数既没有元数据（底表空）也没有 `@inject`（覆盖表无此下标）时，该下标值为 `undefined`，构造时抛 `TypeInfo not known for "ClassName"`——漏写 `@inject` 会立刻失败而非静默降级，这使"全部参数显式注入"成为可被测试固化的硬约束。
- **README 要求开启 emitDecoratorMetadata 的原因**：官方默认路径依赖 `design:paramtypes` 做自动推断，本项目放弃了这条路径。

### 2.3 构造与递归解析

`container.construct(target)` 从 `typeInfo` 取参数表，逐个 `resolve(token)` 后按位置传入构造函数——解析是**递归下钻、逐层回填**的，整条依赖链在 resolve 根对象时一次性拉起。

## 三、Token 三种形态

`InjectionToken<T> = constructor<T> | string | symbol` [README/源码]。

| 形态 | 注册要求 | 未注册时 resolve | 本项目用法 |
| --- | --- | --- | --- |
| constructor（构造函数） | 可不注册 | **直接 construct（Transient）** [源码] | Handler 类、ApplicationRuntime 解析 |
| symbol | 必须注册 | 抛 `Attempted to resolve unregistered dependency token` | `TOKENS.xxx` 全部依赖角色 |
| string | 必须注册 | 同上抛错 | 不使用（无类型约束，弃用） |

### 3.1 未注册类的回退逻辑（源码）

`resolve()` 的完整分支 [源码]（`dependency-container.js:100-125`）：

```js
resolve(token, context, isOptional) {
  const registration = this.getRegistration(token);
  if (!registration && isNormalToken(token)) {   // string/symbol
    if (isOptional) return undefined;
    throw new Error(`Attempted to resolve unregistered dependency token: ...`);
  }
  if (registration) return this.resolveRegistration(registration, context);
  if (isConstructorToken(token)) {               // 未注册的类
    const result = this.construct(token, context);
    return result;                               // ← 直接 new，Transient
  }
  throw new Error("Attempted to construct an undefined constructor. ...");
}
```

**README 未记载此回退**，它是"类即 token、类即知识"的来源：`c.resolve(HealthCheckTaskHandler)` 无需任何 register，类的 `@injectable()` 参数表就是全部构造知识。

### 3.2 为什么接口必须用 @inject

[README]："Since classes have type information at runtime, we can resolve them without any extra information... Interfaces don't have type information at runtime, so we need to decorate them with `@inject(...)`." 容器自动推断 token 的两个主要例外是**接口和非类类型**（原始值、函数、字面量对象、映射类型如 `Pick<>`）——它们运行时不存在，`@inject()` 里只能填运行时值（Symbol/构造函数），这也是本项目 token 集中用 Symbol 的根本原因。

### 3.3 symbol resolve 的类型坑 [实践]

`resolve(symbolToken)` 无法推断类型（Symbol 不携带类型信息），必须显式泛型：`child.resolve<SqliteStore>(TOKENS.sqliteStore)`，否则推断为 `unknown`。本项目 [tokens.ts](../apps/server/src/composition/tokens.ts) 用 `TokenTypes` 接口维护 token 与值类型的映射，并导出 23 个 token 作为依赖图的单一清单。

## 四、Provider 与注册 API

四类 provider [README]：

| Provider | 形式 | 用途 | 本项目实例 |
| --- | --- | --- | --- |
| Class | `{ token, useClass: constructor }` | 指定实现类 | `TOKENS.taskEngine → TaskEngine` |
| Value | `{ token, useValue: T }` | 常量或已构造对象 | logger、config、clock、httpListen |
| Factory | `{ token, useFactory: (c) => T }` | 工厂构造，可访问容器 | store、legacyAdapter、注册表 |
| Token | `{ token, useToken: otherToken }` | 别名/重定向 | 未使用（仓储别名用工厂实现） |

注册方法：`register(token, provider, options?)`、`registerSingleton`、`registerType`、`registerInstance` [README]。注意 4.10 **没有 `registerValue()` 简写** [实践]，值注册就是 `register(token, { useValue })`。

### 4.1 两个内置工厂

[README]：

- `instanceCachingFactory((c) => T)`：懒构造并缓存，"returning the single instance for each subsequent resolution"——效果近似 `@singleton()`。
- `instancePerContainerCachingFactory((c) => T)`：**按容器**缓存，效果近似 `@scoped(Lifecycle.ContainerScoped)`。

### 4.2 工厂缓存的真正作用域 [实践/源码]

`instanceCachingFactory` 的缓存闭包挂在**本次 register 调用**创建的 provider 上。本项目每次调用 `createAppContainer()` 都新建 child 并重新注册，因此每个 child 拿到各自的工厂实例与缓存——效果严格等于 ContainerScoped，跨 child 不共享（graph.test.ts 验证）。若工厂注册在全局默认容器上，行为则退化为全局单例。

### 4.3 两个实测 API 坑 [实践]

- `register` **不接受裸工厂**：`register(token, instanceCachingFactory(...))` 类型报错，必须包在 `{ useFactory: instanceCachingFactory(...) }` 里。
- 工厂 provider 的 `lifecycle` 选项无效：生命周期选项只控制类 provider 的实例化策略，工厂返回什么、何时调用由工厂函数自决——所以工厂注册不需要（也没法）传 `ContainerScoped`。

## 五、生命周期（Lifecycle）

四种作用域，官方定义 [README]：

| Scope | 行为 | 跨 child 容器 |
| --- | --- | --- |
| `Transient`（**默认**） | "a new instance will be created with each resolve" | 无缓存，谈不上 |
| `ResolutionScoped` | 单次解析链内同实例（一条 resolve 递归中共享） | 按链独立 |
| `ContainerScoped` | "the dependency container will return the same instance each time" | **子容器解析出独立实例** |
| `Singleton` | "Each resolve will return the same instance **(including resolves from child containers)**" | 父容器单例全局唯一 |

装饰器形式：`@singleton()`、`@scoped(Lifecycle.ContainerScoped)` 把注册**固化到全局默认容器** [README]。

### 5.1 为什么本项目禁用 @singleton() [实践]

Singleton 注册挂在全局默认容器上且**跨 child 共享**——两个测试 child 会拿到同一个实例，状态互相污染。本项目全部进程级服务用 `register(..., { lifecycle: Lifecycle.ContainerScoped })` 集中在容器工厂注册：生产 child 内单例、每个测试 child 独立实例。

### 5.2 Transient + 消费结构的"事实单例" [实践]

未注册的类（如六个 Handler）默认 Transient——resolve 一次 new 一个。但它们唯一的消费点是注册表的 `instanceCachingFactory`（整个 child 只执行一次），实际只构造一次。"只一次"不是自己保证的，而是外层工厂缓存保证的；Handler 无状态，即使多实例也无害。

### 5.3 测试辅助 [README]

- `clearInstances()`：清空已缓存实例但**保留注册**（对比 `reset()` 连注册一起清），适合测试中每个用例获得新单例。
- 本项目策略不同：直接每测试新建 child container（见下节），不需要 clearInstances。

## 六、Child Container

[README]：`container.createChildContainer()` 创建子容器，可继续嵌套。核心语义：

- **注册相互独立，解析向上冒泡**："if a registration is absent in the child container at resolution, the token will be resolved from the parent."
- `isRegistered(token, true)` 递归检查父容器注册。
- 典型用法：根容器放通用无状态服务，子容器放特化服务（如 per-request 容器）。

**本项目的用法是官方模式的变体** [实践]：默认 `container` 仅作为父容器/元数据入口（只允许在 composition/container.ts 中 import），每次 `createAppContainer()` 创建 child 并**全量注册**全部 23 个 token 与服务——不依赖父容器冒泡，因此每个 child 是完全自足的依赖图，测试隔离天然成立（graph.test.ts 验证两个 child 的 Store/TaskEngine/Scheduler 互不共享）。

## 七、Disposable 与 dispose()

[README]："All instances created by the container that implement the `Disposable` interface will automatically be disposed." 同步调用 `container.dispose()` 或 `await` 异步释放。

**本项目定位** [实践]：业务类均不实现 `Disposable`——真正的资源释放顺序（停任务 → 停调度 → 关 SSE → 关 HTTP → 等空闲 → 释放探测器 → 关数据库）由 `ApplicationRuntime.stop()` 显式编排，`index.ts` 在 shutdown 末尾 `await child?.dispose()` 仅作容器自身状态闭环的收尾卫生。原则：**关闭顺序是业务决策，不交给容器反射机制**。

## 八、其他 API 速览

| API | 说明 [README] | 本项目 |
| --- | --- | --- |
| `autoInjectable()` | 不装饰也注入（保留无 DI 的直接 new 用法） | 未使用（全显式方案） |
| `@inject(token, { isOptional: true })` | 未注册时注入 `undefined` 而非抛错 | 未使用（依赖缺失应失败） |
| `injectAll(token)` | 注入该 token 的全部注册（多实现） | 未使用 |
| `@registry()` | 装饰器内声明注册 | 未使用（集中注册） |
| `delay(() => import(...))` | 解决循环依赖的懒构造 | 未使用（依赖图无环） |
| interceptors | resolve 前后拦截钩子 | 未使用 |
| `predicateAwareClassFactory` | 条件工厂（默认缓存结果） | 未使用 |

## 九、clash-sentinel 架构决策速查 [实践]

Step 16 建立的使用约定，供后续维护对照：

1. **全显式 token 注入**：所有容器注入的构造参数一律 `@inject(TOKENS.xxx)`；token 是 Symbol（23 个），集中定义于 `apps/server/src/composition/tokens.ts`，token 清单即依赖图的单一事实来源。
2. **编译期收窄与运行时注入分离**：token 注册完整实例，构造参数类型继续 `Pick<>` 收窄——运行时传完整对象（与手工组合根行为一致），编译期边界由类型系统守住；不为每个 Pick 形状造 token。
3. **类型 token 用于"根与叶子"**：`ApplicationRuntime`（注册 + ContainerScoped，注册目的是携带生命周期）与六个 Handler（不注册，靠源码回退直接 construct）用类作 token；中间层服务一律 Symbol token（可替换、可覆盖）。
4. **三类注册的分工**：`useValue`（外部值）/ `{ useClass } + ContainerScoped`（容器构造的服务）/ `useFactory: instanceCachingFactory`（特殊参数对象与注册表），三者单例语义等价、缓存位置不同。
5. **默认容器只作父容器**：业务模块禁止 import `container`；`resolve()` 只出现在 composition、入口（唯一一次 `resolve(ApplicationRuntime)`）和容器测试中（Step 16.4 将加静态架构检查固化）。
6. **不引入 Service Locator**：容器实例不注入任何业务对象。
7. **可选依赖用默认值参数**：位置参数注入下 `logger: AppLogger = noopLogger` 等；跳过某可选参数需显式传 `undefined` 占位（如 runtime 手工装配的 now）。
8. **测试双轨**：单元测试直接 `new`（不经容器，无装饰器依赖）；需要完整依赖图的测试走独立 child + 覆盖注册（如 `TOKENS.httpListen → port: 0`、`TOKENS.sqliteStore → fake`），结束 `dispose()`。

## 附：本项目核心文件

| 文件 | 职责 |
| --- | --- |
| `apps/server/src/composition/tokens.ts` | 23 个 Symbol token 与 `TokenTypes` 类型映射 |
| `apps/server/src/composition/container.ts` | `createAppContainer()` 容器工厂（唯一合法容器入口） |
| `apps/server/src/application-runtime.ts` | 唯一应用根（start/stop 生命周期编排） |
| `apps/server/src/composition/container.test.ts` | 注入机制与作用域冒烟 |
| `apps/server/src/composition/graph.test.ts` | 完整依赖图解析、隔离与覆盖 |
| `apps/server/src/composition/architecture.test.ts` | Service Locator 静态架构约束 |
| `apps/server/src/application-runtime.test.ts` | 正常及失败路径的生命周期测试 |
