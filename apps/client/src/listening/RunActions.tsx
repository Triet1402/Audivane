import type { JSX } from "react";

import type { ExperimentSnapshot } from "@codec-abx/contracts";

export interface RunActionsProps {
  readonly snapshot: ExperimentSnapshot;
  readonly busy: boolean;
  readonly closing: boolean;
  readonly canExport: boolean;
  readonly onExport: () => void;
  readonly onSeal: () => void;
  readonly onReset: () => void;
  readonly onClose: () => void;
}

export function RunActions(props: RunActionsProps): JSX.Element {
  const sealable = props.snapshot.lifecycle === "running" ||
    props.snapshot.lifecycle === "configured";
  return (
    <div className="actions listening-actions">
      <button
        type="button"
        className="secondary"
        disabled={props.busy || !props.canExport}
        onClick={props.onExport}
      >
        Download listening export
      </button>
      <button
        type="button"
        className="secondary quiet"
        disabled={props.busy || !sealable}
        onClick={props.onSeal}
      >
        Seal run (not a final result)
      </button>
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
