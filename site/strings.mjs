// Prints every visible string of one replica state, one per line, for check.sh.
// Usage: node site/strings.mjs <canonical|granary|updated>
// Items marked `demo: true` (and dates marked `demoDates: true`) are not in any real PDF and
// are skipped. Strings are composed exactly as resume.js renders them.
import { pathToFileURL } from "node:url";
import * as data from "./resume-data.js";

const { PROFILE, STATES } = data;

export function visibleStrings(state, profile = PROFILE) {
  const out = [];
  const add = (s) => {
    if (s) out.push(s);
  };
  const join = (...parts) => parts.filter(Boolean).join(", ");

  if (profile) {
    add(profile.name);
    add(profile.email);
    add(profile.homepage);
    add(profile.phone);
  }
  add(state.headline);
  if (state.summary !== undefined) add("Summary");
  add(state.summary);
  for (const [label, value] of state.skills ?? []) {
    add(label);
    add(value);
  }
  for (const section of state.sections ?? []) {
    add(section.title);
    for (const item of section.items ?? []) {
      if (item.demo) continue;
      switch (item.kind) {
        case "role":
          add(join(item.title, item.org, item.location));
          if (!item.demoDates) add(item.dates);
          break;
        case "project":
          add(join(item.title, item.org));
          add(item.dates);
          add(item.note ? `${item.link} (${item.note})` : item.link);
          break;
        case "degree":
          add(`${join(item.school, item.location)} — ${item.degree}`);
          add(item.dates);
          if (item.dissertation) add(`Dissertation: ${item.dissertation}`);
          break;
        case "pub":
          add([item.title, item.venue, item.award].filter(Boolean).join(" "));
          add(item.authors);
          break;
        case "line":
          add(item.text);
          add(item.years);
          break;
      }
      for (const bullet of item.bullets ?? []) add(bullet.text);
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.argv[2];
  if (!Object.hasOwn(STATES, key)) {
    console.error(`usage: strings.mjs <${Object.keys(STATES).join("|")}>`);
    process.exit(2);
  }
  for (const s of visibleStrings(STATES[key])) console.log(s);
}
