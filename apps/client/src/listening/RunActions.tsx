import type { JSX } from "react";

export interface RunActionsProps {
  readonly closing: boolean;
  readonly onReset: () => void;
  readonly onClose: () => void;
}

export function RunActions(props: RunActionsProps): JSX.Element {
  return (
    <div className="actions listening-actions">
      <button
        type="button"
        className="secondary quiet"
        disabled={props.closing}
        onClick={props.onReset}
      >
        Reset listening run
      </button>
      <button
        type="button"
        className="secondary quiet"
        disabled={props.closing}
        onClick={props.onClose}
      >
        Close listening run
      </button>
    </div>
  );
}
