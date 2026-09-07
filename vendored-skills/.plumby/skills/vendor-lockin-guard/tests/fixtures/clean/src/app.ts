// A perfectly ordinary application file with no vendor lock-in signals.
import { useState } from 'react';
import { formatDate } from './util';

export function App() {
  const [count, setCount] = useState(0);
  return { count, setCount, formatDate };
}
