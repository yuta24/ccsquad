import { CcsquadError } from "../error.js";

const JOB_ID_RE = /^J\d{6,}$/;

export function assertValidJobId(id: string): void {
  if (!JOB_ID_RE.test(id)) {
    throw new CcsquadError(
      "job",
      `不正なジョブ ID です: ${id} (形式: J000001)`,
    );
  }
}
