/** @typedef {{ files: Array<{ path: string }> }} PackRecord */

/** Normalize the array and name-keyed object shapes used by npm pack --json. */
export function readPackRecord(result) {
  const records = Array.isArray(result)
    ? result
    : result !== null && typeof result === "object"
      ? Object.values(result)
      : [];

  if (records.length !== 1)
    throw new Error(`Expected one packed artifact, received ${records.length}.`);

  const record = records[0];
  if (
    record === null ||
    typeof record !== "object" ||
    !Array.isArray(record.files) ||
    !record.files.every(
      (file) => file !== null && typeof file === "object" && typeof file.path === "string",
    )
  ) {
    throw new Error("npm pack returned an invalid artifact record.");
  }

  return /** @type {PackRecord} */ (record);
}
