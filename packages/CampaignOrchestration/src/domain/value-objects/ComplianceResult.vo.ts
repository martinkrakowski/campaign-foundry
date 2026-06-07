// @generated value-object stub — edit freely
/**
 * ComplianceResult is an immutable value object.
 *
 * Value objects:
 * - Are immutable (no setters)
 * - Are compared by value, not identity
 * - Contain validation logic
 * - Can be shared safely
 *
 * @example
 * const vo = ComplianceResult.create(rawValue);
 * if (vo.success) {
 *   // Use vo.value
 * }
 */
export class ComplianceResult {
  /**
   * Private constructor enforces factory pattern.
   * Use ComplianceResult.create() instead.
   */
  private constructor(private readonly value: unknown) {
    // Value is immutable after construction
  }

  /**
   * Factory method with validation.
   *
   * @param value - Raw value to wrap
   * @returns Result containing ComplianceResult or validation error
   *
   * TODO: Implement validation logic
   * Example:
   * static create(value: string): Result<ComplianceResult, Error> {
   *   if (!value || value.length === 0) {
   *     return { success: false, error: new Error('Value cannot be empty') };
   *   }
   *   return { success: true, value: new ComplianceResult(value) };
   * }
   */
  static create(value: unknown): { success: boolean; value?: ComplianceResult; error?: Error } {
    // TODO: Add validation
    return { success: true, value: new ComplianceResult(value) };
  }

  /**
   * Get the wrapped value.
   */
  getValue(): unknown {
    return this.value;
  }

  /**
   * Value objects are compared by value.
   */
  equals(other: ComplianceResult): boolean {
    return this.value === other.value;
  }
}
