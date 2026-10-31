import { MATH_ENVS, VERBATIM_ENVS } from "./latexHighlight";
import type { TheoremDef, TheoremMap, TheoremSpec, TheoremTitle } from "../tex/theorems";

export interface EnvironmentVisualization {
  environment: string;
  render?: "box" | "source";
  name?: string;
  color?: string;
  arguments?: TheoremSpec;
  titlePosition?: TheoremTitle;
  numbered?: boolean;
  labelPrefix?: string;
  qed?: string;
}

export interface TemplateVisualizationProfile {
  id: string;
  name: string;
  environments: EnvironmentVisualization[];
}

export interface TemplateVisualization {
  theorems: TheoremMap;
  source: ReadonlySet<string>;
}

const SPECS = new Set(["", "o", "m", "tcb", "tcb*"]);
const TITLES = new Set(["paren", "after", "replace", "name"]);
const RESERVED = new Set([...MATH_ENVS, ...VERBATIM_ENVS, "document", "itemize", "enumerate", "description", "problemset", "center", "figure", "figure*", "table", "table*", "tikzpicture", "tikzcd", "pgfpicture", "circuitikz", "tabular", "tabular*", "tabularx", "longtable"]);
const FIELDS = new Set(["environment", "render", "name", "color", "arguments", "titlePosition", "numbered", "labelPrefix", "qed"]);

/** Validate the whole draft before saving; fields are plain text and literal hex colors. */
export function parseTemplateProfiles(value: unknown): TemplateVisualizationProfile[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error("Use an array of at most 30 template profiles.");
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Profile ${index + 1} must be an object.`);
    const p = raw as Record<string, unknown>;
    if (Object.keys(p).some(key => !["id", "name", "environments"].includes(key))) throw new Error(`Profile ${index + 1} has an unknown field.`);
    if (typeof p.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(p.id) || p.id === "auto" || ids.has(p.id)) throw new Error(`Profile ${index + 1} needs a unique ID (letters, digits, - or _).`);
    ids.add(p.id);
    if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 120) throw new Error(`Profile ${index + 1} needs a name of 1–120 characters.`);
    if (!Array.isArray(p.environments) || p.environments.length > 100) throw new Error(`${p.name}: use at most 100 environment rules.`);
    const seen = new Set<string>();
    const environments = p.environments.map((rawRule, i) => {
      if (!rawRule || typeof rawRule !== "object") throw new Error(`${p.name}: rule ${i + 1} must be an object.`);
      const r = rawRule as Record<string, unknown>;
      if (Object.keys(r).some(key => !FIELDS.has(key))) throw new Error(`${p.name}: rule ${i + 1} has an unknown field.`);
      if (typeof r.environment !== "string" || r.environment.length > 120 || !/^[^\s{}\\]+$/.test(r.environment) || seen.has(r.environment)) throw new Error(`${p.name}: each rule needs a unique literal environment name.`);
      seen.add(r.environment);
      if (r.render !== undefined && r.render !== "box" && r.render !== "source") throw new Error(`${r.environment}: choose box or source.`);
      if (r.render !== "source" && RESERVED.has(r.environment)) throw new Error(`${r.environment} uses a dedicated math, list, image or code renderer; choose source to keep its markup.`);
      for (const field of ["name", "labelPrefix", "qed"] as const) {
        if (r[field] !== undefined && (typeof r[field] !== "string" || (r[field] as string).length > 120)) throw new Error(`${r.environment}: ${field} must be plain text of at most 120 characters.`);
      }
      if (r.labelPrefix !== undefined && !/^[^\s{}\\]*$/.test(r.labelPrefix as string)) throw new Error(`${r.environment}: use a literal label prefix without braces, spaces or commands.`);
      if (r.color !== undefined && (typeof r.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(r.color))) throw new Error(`${r.environment}: color must be #RRGGBB.`);
      if (r.arguments !== undefined && !SPECS.has(r.arguments as string)) throw new Error(`${r.environment}: unsupported title arguments.`);
      if (r.titlePosition !== undefined && !TITLES.has(r.titlePosition as string)) throw new Error(`${r.environment}: unsupported title position.`);
      if (r.numbered !== undefined && typeof r.numbered !== "boolean") throw new Error(`${r.environment}: numbered must be true or false.`);
      return { ...r } as unknown as EnvironmentVisualization;
    });
    return { id: p.id, name: p.name.trim(), environments };
  });
}

/** Only the live editor reads this map: PDF, references and fragment TeX keep native authority. */
export function applyTemplateVisualization(native: TheoremMap, profile: TemplateVisualizationProfile | null): TemplateVisualization {
  if (!profile) return { theorems: native, source: new Set() };
  const valid = parseTemplateProfiles([profile])[0];
  const theorems = new Map(native), source = new Set<string>();
  for (const rule of valid.environments) {
    if (rule.render === "source") { theorems.delete(rule.environment); source.add(rule.environment); continue; }
    const base: TheoremDef = native.get(rule.environment) ?? {
      name: rule.environment, numbered: false, spec: "", title: "paren", punct: "", prefix: null,
      role: null, color: null, qed: null, nameMacro: false, counter: null, user: false,
    };
    theorems.set(rule.environment, {
      ...base,
      name: rule.name ?? base.name,
      color: rule.color ?? base.color,
      spec: rule.arguments ?? base.spec,
      title: rule.titlePosition ?? base.title,
      numbered: rule.numbered ?? base.numbered,
      prefix: rule.labelPrefix ?? base.prefix,
      qed: rule.qed ?? base.qed,
    });
  }
  return { theorems, source };
}
