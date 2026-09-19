// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { expect, test, vi } from 'vitest';

const start = vi.fn();
const stop = vi.fn();
const unsubscribe = vi.fn();
let listener:
  ((state: 'connecting' | 'connected' | 'offline') => void) | undefined;

vi.mock('../../stream.js', () => ({
  DashboardStream: class {
    start = start;
    stop = stop;
    subscribe(callback: typeof listener) {
      listener = callback;
      callback?.('connecting');
      return unsubscribe;
    }
  },
}));

import { useDashboardStream } from './useDashboardStream.js';

test('接入流状态并在卸载时释放资源', () => {
  const client = new QueryClient();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useDashboardStream(), {
    wrapper,
  });
  expect(start).toHaveBeenCalledOnce();
  act(() => listener?.('connected'));
  expect(result.current).toBe('connected');
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
});
