const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  diffWizardSnapshots,
  parseWizardProfile,
  snapshotFromProfile,
} = require("../src/wizard");

const profileHtml = `
  <html><body>
    <table><tr><td>
      <table>
        <tr><td colspan="2">Profile for Mr. Wizard</td></tr>
        <tr><td>Username</td><td>Mr. Wizard <a href="/send">Send U2U</a></td></tr>
        <tr><td>Name:</td><td>First Name Last Name</td></tr>
        <tr><td>Registered</td><td>2/16/03 (0 messages per day)</td></tr>
        <tr><td>Posts</td><td>11 (0.59% of total posts.)</td></tr>
        <tr><td>Avatar &amp; Member Status:</td><td><img src="https://img.test/avatar.jpg"> Member</td></tr>
        <tr><td>Last active:</td><td>9-21-2026 at 17:35</td></tr>
      </table>
    </td></tr></table>
    <table><tr><td>
      <table>
        <tr><td colspan="2">Other Information</td></tr>
        <tr><td>City</td><td>Boston</td></tr>
        <tr><td>Province/State</td><td>MA</td></tr>
        <tr><td>Country</td><td>United States of America</td></tr>
        <tr><td>Location</td><td>Massachusetts, USA</td></tr>
        <tr><td>Birthday:</td><td></td></tr>
        <tr><td>Bio:</td><td></td></tr>
        <tr><td>Current Mood:</td><td>No Mood.</td></tr>
      </table>
    </td></tr></table>
  </body></html>
`;

test("parses every stable Wizard profile field and excludes Last active", () => {
  const profile = parseWizardProfile(profileHtml);
  const fields = Object.fromEntries(
    profile.fields.map((field) => [field.key, field.value])
  );

  assert.equal(profile.profileName, "Mr. Wizard");
  assert.equal(profile.username, "Mr. Wizard");
  assert.equal(profile.avatarUrl, "https://img.test/avatar.jpg");
  assert.equal(fields.username, "Mr. Wizard");
  assert.equal(fields.posts, "11 (0.59% of total posts.)");
  assert.equal(fields.current_mood, "No Mood.");
  assert.equal(fields.birthday, "");
  assert.equal(fields.avatar_url, "https://img.test/avatar.jpg");
  assert.equal("last_active" in fields, false);
});

test("diffs added, changed, and removed fields without volatile page text", () => {
  const before = snapshotFromProfile(parseWizardProfile(profileHtml));
  const after = structuredClone(before);
  after.posts.value = "12 (0.64% of total posts.)";
  after.bio.value = "Wizard inventor";
  delete after.city;
  after.favorite_card = { label: "Favorite Card", value: "Wizard" };

  assert.deepEqual(diffWizardSnapshots(before, after), [
    {
      type: "changed",
      key: "bio",
      label: "Bio",
      oldValue: "",
      newValue: "Wizard inventor",
    },
    {
      type: "removed",
      key: "city",
      label: "City",
      oldValue: "Boston",
      newValue: null,
    },
    {
      type: "added",
      key: "favorite_card",
      label: "Favorite Card",
      oldValue: null,
      newValue: "Wizard",
    },
    {
      type: "changed",
      key: "posts",
      label: "Posts",
      oldValue: "11 (0.59% of total posts.)",
      newValue: "12 (0.64% of total posts.)",
    },
  ]);
});

test("persists the current profile snapshot and field-level history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagepulse-wizard-"));
  process.env.DATA_DIR = directory;
  const { db, saveWizardProfile, statements } = require("../src/db");
  try {
    const profile = parseWizardProfile(profileHtml);
    const snapshot = snapshotFromProfile(profile);
    saveWizardProfile(profile, snapshot, [{
      type: "changed",
      key: "city",
      label: "City",
      oldValue: "Boston",
      newValue: "Salem",
    }]);

    const state = statements.getWizardProfileState.get();
    assert.equal(state.baselined, 1);
    assert.equal(state.avatar_url, "https://img.test/avatar.jpg");
    assert.deepEqual(JSON.parse(state.snapshot_json).city, {
      label: "City",
      value: "Boston",
    });
    const change = statements.recentWizardProfileChanges.all(1)[0];
    assert.equal(change.change_type, "changed");
    assert.equal(change.field_key, "city");
    assert.equal(change.field_label, "City");
    assert.equal(change.old_value, "Boston");
    assert.equal(change.new_value, "Salem");
    assert.ok(change.detected_at);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
