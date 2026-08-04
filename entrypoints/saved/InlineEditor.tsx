import { useEffect, useId, useRef, useState } from 'react';

interface InlineEditorProps {
  label: string;
  value: string;
  fallbackValue: string;
  pending?: boolean;
  onSave: (value: string) => Promise<boolean>;
  onCancel: () => void;
}

export function InlineEditor({
  label,
  value,
  fallbackValue,
  pending = false,
  onSave,
  onCancel,
}: InlineEditorProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  async function save() {
    const nextValue = draft.trim();
    if (!nextValue || nextValue === value.trim()) {
      onCancel();
      return;
    }
    await onSave(nextValue);
  }

  return (
    <span className="inline-editor">
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        value={draft}
        placeholder={fallbackValue}
        disabled={pending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void save();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <button type="button" disabled={pending} onClick={() => void save()}>
        保存
      </button>
      <button type="button" disabled={pending} onClick={onCancel}>
        取消
      </button>
    </span>
  );
}
