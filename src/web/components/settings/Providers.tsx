import { RefreshCw } from 'lucide-react';
import { useApp } from '../../state/app';
import { api, attempt } from '../../state/api';
import { Button, EmptyState } from '../ui';
import { SectionHead, useBusy } from './common';

export function ProvidersSection() {
  const providers = useApp((s) => s.providers);
  const [busy, run] = useBusy();

  return (
    <section className="section">
      <SectionHead
        title="Providers"
        desc="The coding agents Jogger found on this machine. Install or sign in to a CLI, then refresh."
        action={
          <Button size="sm" icon={RefreshCw} busy={busy} onClick={() => void run(() => attempt(api.refreshProviders()))}>
            Refresh
          </Button>
        }
      />
      {providers.length === 0 ? (
        <div className="list">
          <EmptyState title="No providers registered">The daemon did not report any agent adapters.</EmptyState>
        </div>
      ) : (
        <div className="list">
          {providers.map((p) => (
            <div key={p.id} className="list-row provider-row">
              <span className={`provider-dot ${p.available ? 'is-ok' : 'is-off'}`} aria-label={p.available ? 'Available' : 'Unavailable'} />
              <div className="provider-main">
                <div className="provider-name">
                  <span>{p.label}</span>
                  <span className="mono muted">{p.id}</span>
                  {p.version ? <span className="mono muted provider-version">{p.version}</span> : null}
                </div>
                {p.error ? (
                  <div className={`provider-error${p.available ? '' : ' is-error'}`}>{p.error}</div>
                ) : (
                  <div className="provider-sub muted">
                    <span className="num">{p.models.length}</span> {p.models.length === 1 ? 'model' : 'models'}
                    {p.defaultModel ? (
                      <>
                        {' '}
                        · default <span className="mono">{p.defaultModel}</span>
                      </>
                    ) : null}
                  </div>
                )}
              </div>
              <span className={`provider-state ${p.available ? 'is-ok' : 'is-off'}`}>{p.available ? 'Available' : 'Unavailable'}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
