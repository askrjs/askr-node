import { describe, expect, it } from "vitest";
import { readPackRecord } from "./pack-result.js";

const record = { filename: "package.tgz", files: [{ path: "dist/index.js" }] };

describe("npm pack JSON normalization", () => {
  it.each([[record], { "@askrjs/node": record }])(
    "should read one artifact from the supported npm result shape",
    (result) => {
      expect(readPackRecord(result)).toBe(record);
    },
  );

  it.each([[], [record, record], {}, null, "invalid"])(
    "should reject a result without exactly one artifact",
    (result) => {
      expect(() => readPackRecord(result)).toThrow(/Expected one packed artifact/);
    },
  );

  it("should reject malformed artifact records", () => {
    expect(() => readPackRecord([{ files: [{ path: 1 }] }])).toThrow(
      "npm pack returned an invalid artifact record.",
    );
  });
});
