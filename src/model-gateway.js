/**
 * Product-owned model boundary. Implementations may transform language, but
 * they never own provider selection, policy, evidence, or side effects.
 */
export class ModelGateway {
  async plan() {
    throw new Error("ModelGateway.plan is not implemented");
  }

  async draft() {
    throw new Error("ModelGateway.draft is not implemented");
  }

  async write(input, context = {}) {
    return this.draft(input, context);
  }

  provenance() {
    return undefined;
  }
}
