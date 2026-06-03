import { describe, expect, test } from "bun:test";
import { CcsquadError, type ErrorKind } from "./error";

describe("ErrorKind", () => {
  test("network は有効な ErrorKind である", () => {
    const kind: ErrorKind = "network";
    expect(kind).toBe("network");
  });
});

describe("CcsquadError", () => {
  test("kind: network でインスタンス化できる", () => {
    const err = new CcsquadError("network", "connection refused");
    expect(err.kind).toBe("network");
    expect(err.message).toBe("connection refused");
    expect(err.name).toBe("CcsquadError");
    expect(err).toBeInstanceOf(Error);
  });

  test("kind: network は CcsquadError のインスタンスである", () => {
    const err = new CcsquadError("network", "timeout");
    expect(err).toBeInstanceOf(CcsquadError);
  });
});
