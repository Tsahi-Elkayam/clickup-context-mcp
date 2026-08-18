import type { ClickUpClient } from "./clickup.js";

/**
 * Custom fields. query_tasks could already *filter* on them; this sets them.
 *
 * The trap: `value` is typed per field. A drop_down wants the option's index or
 * uuid, not its label; a labels field wants an array of option ids; users want
 * an {add,rem} object; dates want unix ms. coerceValue() maps what a human
 * would type onto what the field actually accepts, and refuses rather than
 * sending something that would silently store the wrong thing.
 */

export interface FieldOption {
  id?: string;
  name?: string;
  label?: string;
  orderindex?: number;
}

export interface CustomField {
  id: string;
  name?: string;
  type?: string;
  type_config?: { options?: FieldOption[] };
  value?: unknown;
}

export async function listFields(client: ClickUpClient, listId: string): Promise<CustomField[]> {
  const data = await client.get<{ fields?: CustomField[] }>(
    `/list/${encodeURIComponent(listId)}/field`
  );
  return data.fields ?? [];
}

const optionLabel = (o: FieldOption) => o.name ?? o.label ?? "";

/**
 * Turn a human-typed value into the shape this field's type accepts.
 * Returns an error string instead of guessing when the value can't be matched —
 * a wrong custom field value is invisible until someone reports the bad report.
 */
export function coerceValue(
  field: CustomField,
  input: string
): { value: unknown } | { error: string } {
  const type = field.type ?? "";
  const options = field.type_config?.options ?? [];

  const matchOption = (text: string): FieldOption | undefined => {
    const t = text.trim().toLowerCase();
    return (
      options.find((o) => optionLabel(o).toLowerCase() === t) ??
      options.find((o) => optionLabel(o).toLowerCase().includes(t)) ??
      options.find((o) => o.id === text.trim())
    );
  };

  switch (type) {
    case "drop_down": {
      const hit = matchOption(input);
      if (!hit) {
        return {
          error: `"${input}" is not an option on "${field.name}". Options: ${options
            .map(optionLabel)
            .filter(Boolean)
            .join(", ")}`,
        };
      }
      // ClickUp accepts the option's uuid; orderindex works on older fields.
      return { value: hit.id ?? hit.orderindex };
    }
    case "labels": {
      const wanted = input.split(",").map((s) => s.trim()).filter(Boolean);
      const ids: string[] = [];
      for (const w of wanted) {
        const hit = matchOption(w);
        if (!hit?.id) {
          return {
            error: `"${w}" is not a label on "${field.name}". Labels: ${options
              .map(optionLabel)
              .filter(Boolean)
              .join(", ")}`,
          };
        }
        ids.push(hit.id);
      }
      return { value: ids };
    }
    case "checkbox":
      return { value: /^(true|yes|1|done|checked)$/i.test(input.trim()) };
    case "number":
    case "currency": {
      const n = Number(input);
      if (!Number.isFinite(n)) return { error: `"${input}" is not a number.` };
      return { value: n };
    }
    case "date": {
      const ms = /^\d{10,}$/.test(input.trim()) ? Number(input) : Date.parse(input);
      if (Number.isNaN(ms)) return { error: `"${input}" is not a date. Use ISO or unix ms.` };
      return { value: ms };
    }
    case "users": {
      const ids = input.split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
      if (!ids.length) return { error: "users fields take numeric user ids (see list_members)." };
      return { value: { add: ids, rem: [] } };
    }
    // text, short_text, url, email, phone, emoji, location, …
    default:
      return { value: input };
  }
}

export function setFieldValue(
  client: ClickUpClient,
  taskId: string,
  fieldId: string,
  value: unknown,
  useCustomId = false
): Promise<unknown> {
  // POST is the intuitive verb here and it is NOT the one ClickUp accepts.
  return client.request<unknown>(
    "PUT",
    `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`,
    client.customIdParams(useCustomId),
    { value }
  );
}

export function clearFieldValue(
  client: ClickUpClient,
  taskId: string,
  fieldId: string,
  useCustomId = false
): Promise<unknown> {
  return client.request<unknown>(
    "DELETE",
    `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`,
    client.customIdParams(useCustomId)
  );
}

export function renderFields(fields: CustomField[]): string {
  if (!fields.length) return "This List has no custom fields.";
  const rows = fields.map((f) => {
    const opts = (f.type_config?.options ?? []).map(optionLabel).filter(Boolean).join(", ");
    return `| \`${f.id}\` | ${f.name ?? "—"} | ${f.type ?? "—"} | ${opts || "—"} |`;
  });
  return `# ${fields.length} custom field(s)\n\n| Field ID | Name | Type | Options |\n|---|---|---|---|\n${rows.join("\n")}`;
}
