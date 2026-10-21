import { z } from "zod";
import { WorkflowInputValidationError } from "./registry";

type Schema = Record<string, any>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Address a creative field under a program-selected slot, never a job/array
 * pointer. The execution schema owns the names, types and limits. */
export function stageWorkflowInputField(root: Record<string, unknown>, field: unknown, value: unknown, schema: Schema): Record<string, unknown> {
  if (!Array.isArray(field) || field.length < 1 || field.length > 16) throw new WorkflowInputValidationError("field 须为 1–16 段内容字段名/数组下标，如 [\"generation\",\"camera\"]。", "draft_field_invalid");
  const copy = structuredClone(root);
  let current: any = copy;
  let shape = schema;
  for (const [index, key] of field.entries()) {
    let child: Schema;
    if (Array.isArray(current)) {
      if (!Number.isSafeInteger(key) || key < 0 || key > current.length || key >= (shape.maxItems ?? 32768) || !object(shape.items)) {
        throw new WorkflowInputValidationError("field 数组下标只能修改已有项或紧邻追加，不能跳号。", "draft_field_invalid");
      }
      child = shape.items;
    } else {
      if (!object(current) || typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)
        || !object(shape.properties) || !Object.hasOwn(shape.properties, key)) {
        throw new WorkflowInputValidationError("field 不是当前内容 schema 声明的字段；不能写格号、任务引用或冻结请求。", "draft_field_invalid");
      }
      child = shape.properties[key] as Schema;
    }
    const container = current as Record<string | number, unknown>;
    if (index === field.length - 1) {
      const result = z.fromJSONSchema(child as Parameters<typeof z.fromJSONSchema>[0]).safeParse(value);
      if (!result.success) throw new WorkflowInputValidationError(
        `field ${JSON.stringify(field)}: ${result.error.issues.slice(0, 8).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        "draft_field_invalid");
      // Preserve source values, not Zod coercions/defaults; full domain validation
      // still happens when the complete slot is committed.
      container[key] = value;
    } else {
      if (container[key] === undefined) container[key] = child.type === "array" ? [] : {};
      current = container[key];
      shape = child;
    }
  }
  return copy;
}
