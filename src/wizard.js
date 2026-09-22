const cheerio = require("cheerio");
const { OPENAI_BROWSER_UA } = require("./discovery");

const WIZARD_PROFILE_URL =
  "https://wizardcards.com/member.php?action=viewpro&member=Mr.%20Wizard";
const WIZARD_FETCH_TIMEOUT_MS = 20_000;

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function fieldKey(label) {
  return normalizeText(label)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function profileTables($) {
  return $("table")
    .filter((_index, table) => {
      const heading = normalizeText($(table).find("tr").first().text());
      return heading.startsWith("Profile for ") || heading === "Other Information";
    })
    .filter((_index, table) => {
      const nestedMatch = $(table)
        .find("table")
        .toArray()
        .some((nested) => {
          const heading = normalizeText($(nested).find("tr").first().text());
          return heading.startsWith("Profile for ") || heading === "Other Information";
        });
      return !nestedMatch;
    });
}

function parseWizardProfile(html, url = WIZARD_PROFILE_URL) {
  const $ = cheerio.load(String(html || ""));
  const fields = [];
  let avatarUrl = null;
  let profileName = "Mr. Wizard";

  profileTables($).each((_tableIndex, table) => {
    $(table)
      .find("tr")
      .each((rowIndex, row) => {
        const cells = $(row).children("td");
        if (rowIndex === 0) {
          const heading = normalizeText(cells.first().text());
          if (heading.startsWith("Profile for ")) {
            profileName = heading.slice("Profile for ".length).trim() || profileName;
          }
          return;
        }
        if (cells.length < 2) return;

        const label = normalizeText(cells.eq(0).text()).replace(/:$/, "");
        const key = fieldKey(label);
        if (!key || key === "last_active") return;

        const valueCell = cells.eq(1).clone();
        valueCell.find("a").remove();
        const rawValue = normalizeText(valueCell.text());
        const value =
          key === "username"
            ? normalizeText(rawValue.replace(/\(\s*\)/g, ""))
            : rawValue;
        fields.push({ key, label, value });

        if (key === "avatar_and_member_status") {
          const source = $(row).find("img[src]").first().attr("src");
          if (source) {
            try {
              avatarUrl = new URL(source, url).toString();
            } catch {
              avatarUrl = source;
            }
          }
        }
      });
  });

  if (!fields.length) {
    throw new Error("Wizard profile tables were not found");
  }

  fields.push({
    key: "avatar_url",
    label: "Avatar",
    value: avatarUrl || "",
  });

  const username = fields.find((field) => field.key === "username")?.value || profileName;
  return {
    avatarUrl,
    fields,
    profileName,
    username,
    url,
  };
}

function snapshotFromProfile(profile) {
  return Object.fromEntries(
    profile.fields.map((field) => [
      field.key,
      { label: field.label, value: field.value },
    ])
  );
}

function diffWizardSnapshots(previous, current) {
  const before = previous && typeof previous === "object" ? previous : {};
  const after = current && typeof current === "object" ? current : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes = [];

  for (const key of keys) {
    const oldField = before[key];
    const newField = after[key];
    if (!oldField && newField) {
      changes.push({
        type: "added",
        key,
        label: newField.label || key,
        oldValue: null,
        newValue: String(newField.value ?? ""),
      });
    } else if (oldField && !newField) {
      changes.push({
        type: "removed",
        key,
        label: oldField.label || key,
        oldValue: String(oldField.value ?? ""),
        newValue: null,
      });
    } else if (String(oldField?.value ?? "") !== String(newField?.value ?? "")) {
      changes.push({
        type: "changed",
        key,
        label: newField?.label || oldField?.label || key,
        oldValue: String(oldField?.value ?? ""),
        newValue: String(newField?.value ?? ""),
      });
    }
  }
  return changes;
}

async function fetchWizardProfile() {
  const target = new URL(WIZARD_PROFILE_URL);
  target.searchParams.set("t", String(Date.now()));
  const response = await fetch(target, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": OPENAI_BROWSER_UA,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(WIZARD_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} at ${WIZARD_PROFILE_URL}`);
  }
  return parseWizardProfile(await response.text());
}

module.exports = {
  WIZARD_PROFILE_URL,
  diffWizardSnapshots,
  fetchWizardProfile,
  fieldKey,
  parseWizardProfile,
  snapshotFromProfile,
};
