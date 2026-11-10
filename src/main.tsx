import { Component, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bootstrap } from '../shared/types';
import { api, errorText } from './lib/api';
import { StateProvider, useApp } from './state';
import { WorkspaceView } from './workspace';
import { ErrorMessage, Loading } from './components/ui';
import 'dockview-react/dist/styles/dockview.css';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="boot">
        <ErrorMessage message={this.state.error} retry={() => location.reload()} />
      </div>
    ) : (
      this.props.children
    );
  }
}
function Workspace() {
  const { workspaces, activeId } = useApp();
  const workspace = workspaces.find((w) => w.id === activeId) || workspaces[0];
  return <WorkspaceView key={workspace.id} workspace={workspace} />;
}
function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Bootstrap>('/api/bootstrap')
      .then(setData)
      .catch((error) => setError(errorText(error)));
  }, []);
  if (error)
    return (
      <div className="boot">
        <ErrorMessage message={error} retry={() => location.reload()} />
      </div>
    );
  if (!data)
    return (
      <div className="boot">
        <Loading label="Opening your workspace…" />
      </div>
    );
  return (
    <StateProvider initial={data}>
      <Workspace />
    </StateProvider>
  );
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
