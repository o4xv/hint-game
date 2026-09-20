/** Fail fast when an internal collection invariant is broken. */
export function present<T>(value: T, message = "Missing internal state"): NonNullable<T> {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}
