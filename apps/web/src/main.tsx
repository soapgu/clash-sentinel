import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { healthResponseSchema } from '@clash-sentinel/shared';
import './style.css';

/** 全站共享的服务端状态查询客户端。 */
const client = new QueryClient();

/**
 * 渲染服务连接状态占位页，并通过同源健康接口查询后台是否可达。
 *
 * @returns 首页 React 元素。
 */
function Home() {
  const query = useQuery({
    queryKey: ['health'],
    retry: false,
    queryFn: async () => {
      const response = await fetch('/api/health', {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('后台不可达');
      return healthResponseSchema.parse(await response.json());
    },
  });
  return (
    <main>
      <h1>Clash Sentinel</h1>
      <p>工程骨架阶段</p>
      <p role="status">
        {query.isPending
          ? '正在连接后台…'
          : query.isError
            ? '后台连接失败，请检查服务是否启动。'
            : '后台已连接'}
      </p>
      <p>这里只验证后台服务连接，不代表 Clash 或互联网健康。</p>
      <button onClick={() => void query.refetch()} disabled={query.isFetching}>
        重新检查后台连接
      </button>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<Home />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
