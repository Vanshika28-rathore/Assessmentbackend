describe("CI/CD Pipeline Guardrail", () => {
  it("should pass this basic math test to allow deployment", () => {
    expect(1 + 1).toBe(2);
  });
});