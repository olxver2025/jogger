import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { closePane } from '../state/ui';
import { IconButton } from './ui';

/** The header strip every pane view uses. Always ends with the close-pane button. */
export function PaneBar({ paneIndex, children, actions }: { paneIndex: number; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="pane-head">
      <div className="pane-head-main">{children}</div>
      <div className="pane-head-actions">
        {actions}
        <IconButton icon={X} label="Close pane" onClick={() => closePane(paneIndex)} />
      </div>
    </div>
  );
}
