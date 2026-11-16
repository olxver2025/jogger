import { useEffect, useId, useRef, useState } from 'react';
import { FolderPlus } from 'lucide-react';
import type { Project } from '../../shared/protocol';
import { api } from '../state/api';
import { toast } from '../state/toast';
import { Button } from './ui';

/** Folder path input with daemon-side autocomplete. Enter adds, Tab completes the highlighted folder. */
export function AddProject({
  onDone,
  autoFocus,
  size = 'md',
  submitLabel = 'Add project',
}: {
  onDone?: (p: Project | null) => void;
  autoFocus?: boolean;
  size?: 'md' | 'lg';
  submitLabel?: string;
}) {
  const [value, setValue] = useState('~/');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const reqSeq = useRef(0);

  useEffect(() => {
    const seq = ++reqSeq.current;
    const t = window.setTimeout(() => {
      api
        .dirs(value || '~/')
        .then((list) => {
          if (seq !== reqSeq.current) return;
          setSuggestions(list);
          setActive(-1);
        })
        .catch(() => seq === reqSeq.current && setSuggestions([]));
    }, 90);
    return () => window.clearTimeout(t);
  }, [value]);

  const complete = (s: string) => {
    setValue(s.endsWith('/') ? s : s + '/');
    setError(null);
    inputRef.current?.focus();
  };

  const submit = async (path = value) => {
    const p = path.trim().replace(/\/+$/, '') || path.trim();
    if (!p || p === '~') {
      setError('Type the path of a project folder.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject(p);
      toast(`Added ${project.name}`, 'ok');
      setValue('~/');
      setOpen(false);
      onDone?.(project);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const showList = open && suggestions.length > 0;

  return (
    <form
      className={`add-project add-project-${size}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit(active >= 0 ? suggestions[active] : value);
      }}
    >
      <div className="add-project-row">
        <input
          ref={inputRef}
          className="input mono"
          value={value}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          aria-label="Project folder path"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          placeholder="~/code/my-app"
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && suggestions.length) {
              e.preventDefault();
              setOpen(true);
              setActive((a) => (a + 1) % suggestions.length);
            } else if (e.key === 'ArrowUp' && suggestions.length) {
              e.preventDefault();
              setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
            } else if (e.key === 'Tab' && showList && !e.shiftKey) {
              e.preventDefault();
              complete(suggestions[Math.max(active, 0)]);
            } else if (e.key === 'Escape') {
              if (showList) {
                e.stopPropagation();
                setOpen(false);
              } else onDone?.(null);
            }
          }}
        />
        <Button type="submit" variant="primary" size={size === 'lg' ? 'lg' : 'md'} busy={busy} icon={size === 'lg' ? FolderPlus : undefined}>
          {submitLabel}
        </Button>
      </div>
      {showList ? (
        <ul className="suggest fade-y" id={listId} role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={s}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : ''}
              onPointerDown={(e) => {
                e.preventDefault();
                complete(s);
              }}
            >
              {s}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <div className="field-error">{error}</div> : <div className="field-hint">Tab completes a folder · Enter adds it</div>}
    </form>
  );
}
