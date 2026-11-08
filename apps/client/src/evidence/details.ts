export interface EvidenceDetailsState {
  readonly test: boolean;
  readonly measurements: boolean;
  readonly files: boolean;
  readonly canary: boolean;
}

export type EvidenceDetailsChange = (
  key: keyof EvidenceDetailsState,
  open: boolean,
) => void;
