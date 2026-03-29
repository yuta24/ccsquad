export type ErrorKind = "io" | "serialization" | "config" | "job" | "workflow" | "dag";

export class CcsquadError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CcsquadError";
  }
}
