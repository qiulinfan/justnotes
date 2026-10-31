import assert from "node:assert/strict";
import { test } from "node:test";
import { theoremMap } from "../../src/latex/tex/theorems";
import { applyTemplateVisualization, parseTemplateProfiles, type TemplateVisualizationProfile } from "../../src/latex/editor/templateVisualization";

const native = () => theoremMap([String.raw`\documentclass[lang=cn]{elegantbook}`]);
const profile = (environments: TemplateVisualizationProfile["environments"]): TemplateVisualizationProfile => ({ id: "math", name: "数学笔记", environments });

test("custom visualization overrides presentation without mutating native theorem authority", () => {
  const original = native(), before = JSON.stringify([...original]);
  const result = applyTemplateVisualization(original, profile([
    { environment: "definition", name: "My definition", color: "#9933aa" },
    { environment: "customThm", name: "定理", color: "#0099cc", arguments: "tcb", numbered: true },
    { environment: "proof", render: "source" },
  ]));
  assert.equal(result.theorems.get("definition")!.name, "My definition");
  assert.equal(result.theorems.get("definition")!.spec, "tcb", "unspecified title syntax keeps the original template");
  assert.equal(result.theorems.get("definition")!.counter, "tcb@cnt@definition");
  assert.equal(result.theorems.get("customThm")!.counter, null, "custom rules never invent a TeX counter");
  assert.equal(result.theorems.get("customThm")!.prefix, null);
  assert.ok(!result.theorems.has("proof") && result.source.has("proof"));
  assert.equal(JSON.stringify([...original]), before);
  assert.equal(applyTemplateVisualization(original, null).theorems, original);
});

test("profile validation preserves literal Unicode headings and names; rejects executable/style fields and ambiguous rules", () => {
  const valid = parseTemplateProfiles([profile([{ environment: "定理", name: "<img onerror=alert(1)>", labelPrefix: "定理", color: "#abcdef", qed: "□" }])]);
  assert.equal(valid[0].environments[0].name, "<img onerror=alert(1)>", "headings are plain text, rendered through TextWidget");
  assert.equal(parseTemplateProfiles([profile([{ environment: "_thm.1*" }])])[0].environments[0].environment, "_thm.1*");
  for (const rule of [
    { environment: "thm", color: "red; background:url(x)" },
    { environment: "thm", html: "<script>x</script>" },
    { environment: "thm", numbered: "yes" },
    { environment: "thm", arguments: "execute" },
    { environment: "\\thm" },
    { environment: "thm", labelPrefix: "\\label{x}" },
    { environment: "equation", color: "#123456" },
  ]) assert.throws(() => parseTemplateProfiles([profile([rule as never])]));
  assert.throws(() => parseTemplateProfiles([profile([{ environment: "thm" }, { environment: "thm" }])]), /unique/);
  assert.throws(() => parseTemplateProfiles([profile([]), profile([])]), /unique/);
  assert.throws(() => parseTemplateProfiles(Array(31).fill(profile([]))), /30/);
  assert.throws(() => parseTemplateProfiles([profile(Array(101).fill({ environment: "thm" }))]), /100/);
  assert.equal(parseTemplateProfiles([profile([{ environment: "equation", render: "source" }])]).length, 1);
});

test("validated profiles are independent drafts and unknown environments are unnumbered by default", () => {
  const input = [profile([{ environment: "myCustomBox" }])], draft = parseTemplateProfiles(input);
  draft[0].environments[0].name = "Changed";
  assert.equal(input[0].environments[0].name, undefined);
  const def = applyTemplateVisualization(native(), input[0]).theorems.get("myCustomBox")!;
  assert.equal(def.numbered, false);
  assert.equal(def.spec, "");
});
