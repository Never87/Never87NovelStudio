import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { initTheme } from './core/theme/theme';
import { router } from './routes';

/**
 * Application root.
 *
 * Composes global, non-visual initialisation (currently theme sync) and then
 * mounts the router. Feature providers (toasts, repositories) will be added
 * here in later phases without touching the router definition itself.
 */
export default function App() {
  useEffect(() => initTheme(), []);

  return <RouterProvider router={router} />;
}
