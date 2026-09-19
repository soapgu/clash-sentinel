import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DashboardStream, type StreamState } from '../../stream.js';

export function useDashboardStream() {
  const client = useQueryClient();
  const [state, setState] = useState<StreamState>('connecting');
  const stream = useMemo(() => new DashboardStream(client), [client]);
  useEffect(() => {
    const unsubscribe = stream.subscribe(setState);
    stream.start();
    return () => {
      unsubscribe();
      stream.stop();
    };
  }, [stream]);
  return state;
}
