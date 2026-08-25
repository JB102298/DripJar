/**
 * Phase 2 coverage: membership & jar lifecycle.
 *
 * - Organizer invitation management (list without tokens, revoke pending)
 * - Invitation accept edge cases (revoked, rejoin-after-leave reactivation)
 * - Leave jar (non-organizer only, schedule deactivated, access lost)
 * - Remove member (organizer only, not self, access lost, history preserved)
 * - Member PATCH cannot set lifecycle status
 * - Jar settings guards (post-launch financial lock, cancelled read-only)
 * - Schedule guards on cancelled jars
 *
 * Runs against the real Express app + dev database (same pattern as
 * auth-security.test.ts). All records use unique emails per run.
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import app from "../app.js";

const unique = () => `ml-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function registerUser() {
  const email = `${unique()}@example.com`;
  const res = await request(app).post("/api/auth/register").send({
    email,
    password: "password123",
    firstName: "Test",
    lastName: "User",
  });
  expect(res.status).toBe(201);
  return { email, accessToken: res.body.token as string, userId: res.body.user.id as string };
}

async function createJar(token: string) {
  const res = await request(app)
    .post("/api/jars")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: `Trip ${unique()}`,
      // Was the free-text value "travel". `POST /jars` now enforces the
      // canonical category list, which is exactly the arbitrary-value case the
      // contract exists to reject. 82 rows in the development database still
      // carry "travel" and are still read back fine — see
      // jar-category-contract.test.ts.
      category: "Vacation",
      goalAmountCents: 100_000,
      targetDate: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
    });
  expect(res.status).toBe(201);
  return res.body;
}

async function inviteAndAccept(orgToken: string, jarId: string, member: { email: string; accessToken: string }) {
  const invRes = await request(app)
    .post(`/api/jars/${jarId}/invitations`)
    .set("Authorization", `Bearer ${orgToken}`)
    .send({ email: member.email, contributionTargetCents: 20_000 });
  expect(invRes.status).toBe(201);
  const acceptRes = await request(app)
    .post(`/api/invitations/${invRes.body.id}/accept`)
    .set("Authorization", `Bearer ${member.accessToken}`);
  expect(acceptRes.status).toBe(200);
  return { invitationId: invRes.body.id as string, memberId: acceptRes.body.id as string };
}

/** Accept the current agreement for the jar as the given user. No-op if no agreement exists. */
async function acceptCurrentAgreement(token: string, jarId: string) {
  const ags = await request(app)
    .get(`/api/jars/${jarId}/agreements`)
    .set("Authorization", `Bearer ${token}`);
  const agId = ags.body?.[0]?.id as string | undefined;
  if (!agId) return;
  await request(app)
    .post(`/api/jars/${jarId}/agreements/${agId}/accept`)
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
}

// ─── Invitation management ─────────────────────────────────────────────────

describe("organizer invitation management", () => {
  let organizer: Awaited<ReturnType<typeof registerUser>>;
  let outsider: Awaited<ReturnType<typeof registerUser>>;
  let jar: any;

  beforeAll(async () => {
    organizer = await registerUser();
    outsider = await registerUser();
    jar = await createJar(organizer.accessToken);
  });

  it("lists sent invitations without exposing tokens", async () => {
    const email = `${unique()}@example.com`;
    const created = await request(app)
      .post(`/api/jars/${jar.id}/invitations`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ email });
    expect(created.status).toBe(201);

    const res = await request(app)
      .get(`/api/jars/${jar.id}/invitations`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const inv = res.body.find((i: any) => i.email === email);
    expect(inv).toBeDefined();
    expect(inv.status).toBe("pending");
    expect(inv).not.toHaveProperty("token");
  });

  it("rejects the invitation list for non-organizers", async () => {
    const res = await request(app)
      .get(`/api/jars/${jar.id}/invitations`)
      .set("Authorization", `Bearer ${outsider.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("revokes a pending invitation and blocks acceptance afterwards", async () => {
    const invited = await registerUser();
    const created = await request(app)
      .post(`/api/jars/${jar.id}/invitations`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ email: invited.email });
    expect(created.status).toBe(201);

    const revoke = await request(app)
      .post(`/api/jars/${jar.id}/invitations/${created.body.id}/revoke`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(revoke.status).toBe(200);

    // Token lookup no longer resolves
    const lookup = await request(app).get(`/api/invitations/token/${created.body.token}`);
    expect(lookup.status).toBe(404);

    // Accept is blocked
    const accept = await request(app)
      .post(`/api/invitations/${created.body.id}/accept`)
      .set("Authorization", `Bearer ${invited.accessToken}`);
    expect(accept.status).toBe(400);
    expect(accept.body.message).toMatch(/revoked/);
  });

  it("only the organizer can revoke", async () => {
    const created = await request(app)
      .post(`/api/jars/${jar.id}/invitations`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ email: `${unique()}@example.com` });
    const res = await request(app)
      .post(`/api/jars/${jar.id}/invitations/${created.body.id}/revoke`)
      .set("Authorization", `Bearer ${outsider.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("accept is atomic: concurrent accepts of the same invitation succeed exactly once", async () => {
    const invited = await registerUser();
    const created = await request(app)
      .post(`/api/jars/${jar.id}/invitations`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ email: invited.email });
    expect(created.status).toBe(201);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app)
          .post(`/api/invitations/${created.body.id}/accept`)
          .set("Authorization", `Bearer ${invited.accessToken}`),
      ),
    );
    const successes = results.filter((r) => r.status === 200).length;
    expect(successes).toBe(1);
  });

  it("cannot revoke a non-pending invitation", async () => {
    const invited = await registerUser();
    const created = await request(app)
      .post(`/api/jars/${jar.id}/invitations`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ email: invited.email });
    await request(app)
      .post(`/api/invitations/${created.body.id}/accept`)
      .set("Authorization", `Bearer ${invited.accessToken}`)
      .expect(200);

    const res = await request(app)
      .post(`/api/jars/${jar.id}/invitations/${created.body.id}/revoke`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(res.status).toBe(400);
  });
});

// ─── Leave jar ──────────────────────────────────────────────────────────────

describe("leave jar", () => {
  it("organizer cannot leave their own jar", async () => {
    const organizer = await registerUser();
    const jar = await createJar(organizer.accessToken);
    const res = await request(app)
      .post(`/api/jars/${jar.id}/members/leave`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(res.status).toBe(400);
  });

  it("member can leave; schedule is deactivated and access is lost", async () => {
    const organizer = await registerUser();
    const member = await registerUser();
    const jar = await createJar(organizer.accessToken);
    await inviteAndAccept(organizer.accessToken, jar.id, member);

    // Phase 3: member must accept the jar agreement before creating a schedule
    await acceptCurrentAgreement(member.accessToken, jar.id);

    // Member sets up a schedule first
    const sched = await request(app)
      .post(`/api/jars/${jar.id}/schedule`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .send({ frequency: "weekly", amountCents: 1_000, startDate: new Date().toISOString().slice(0, 10) });
    expect(sched.status).toBe(201);

    const leave = await request(app)
      .post(`/api/jars/${jar.id}/members/leave`)
      .set("Authorization", `Bearer ${member.accessToken}`);
    expect(leave.status).toBe(200);

    // Access lost: jar detail, members list, schedule, contributions
    const jarRes = await request(app)
      .get(`/api/jars/${jar.id}`)
      .set("Authorization", `Bearer ${member.accessToken}`);
    expect([403, 404]).toContain(jarRes.status);

    const membersRes = await request(app)
      .get(`/api/jars/${jar.id}/members`)
      .set("Authorization", `Bearer ${member.accessToken}`);
    expect(membersRes.status).toBe(403);

    const contribRes = await request(app)
      .post(`/api/jars/${jar.id}/contributions`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .send({ amountCents: 1_000, contributionDate: new Date().toISOString().slice(0, 10) });
    // 422 = refused by the jar's lifecycle, 403 = refused for membership.
    // Either is a correct "you cannot contribute here"; the lifecycle gate now
    // runs first and answers 422 where it used to answer a generic 400.
    expect([422, 403]).toContain(contribRes.status);

    // Member no longer appears in the members list (organizer view)
    const orgMembers = await request(app)
      .get(`/api/jars/${jar.id}/members`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(orgMembers.status).toBe(200);
    expect(orgMembers.body.find((m: any) => m.userId === member.userId)).toBeUndefined();
  });

  it("cannot leave twice", async () => {
    const organizer = await registerUser();
    const member = await registerUser();
    const jar = await createJar(organizer.accessToken);
    await inviteAndAccept(organizer.accessToken, jar.id, member);

    await request(app)
      .post(`/api/jars/${jar.id}/members/leave`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .expect(200);
    const res = await request(app)
      .post(`/api/jars/${jar.id}/members/leave`)
      .set("Authorization", `Bearer ${member.accessToken}`);
    expect(res.status).toBe(404);
  });

  it("member who left can rejoin via a fresh invitation (same row reactivated)", async () => {
    const organizer = await registerUser();
    const member = await registerUser();
    const jar = await createJar(organizer.accessToken);
    const first = await inviteAndAccept(organizer.accessToken, jar.id, member);

    await request(app)
      .post(`/api/jars/${jar.id}/members/leave`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .expect(200);

    const second = await inviteAndAccept(organizer.accessToken, jar.id, member);
    // Unique jar+user index means the original membership row is reused
    expect(second.memberId).toBe(first.memberId);

    const jarRes = await request(app)
      .get(`/api/jars/${jar.id}`)
      .set("Authorization", `Bearer ${member.accessToken}`);
    expect(jarRes.status).toBe(200);
  });
});

// ─── Remove member ─────────────────────────────────────────────────────────

describe("remove member", () => {
  it("only the organizer can remove; organizer cannot remove self; removed member loses access", async () => {
    const organizer = await registerUser();
    const member = await registerUser();
    const other = await registerUser();
    const jar = await createJar(organizer.accessToken);
    const { memberId } = await inviteAndAccept(organizer.accessToken, jar.id, member);
    await inviteAndAccept(organizer.accessToken, jar.id, other);

    // Non-organizer cannot remove
    const forbidden = await request(app)
      .delete(`/api/jars/${jar.id}/members/${memberId}`)
      .set("Authorization", `Bearer ${other.accessToken}`);
    expect(forbidden.status).toBe(403);

    // Organizer cannot remove their own membership row
    const orgMembers = await request(app)
      .get(`/api/jars/${jar.id}/members`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    const orgRow = orgMembers.body.find((m: any) => m.userId === organizer.userId);
    if (orgRow) {
      const selfRemove = await request(app)
        .delete(`/api/jars/${jar.id}/members/${orgRow.id}`)
        .set("Authorization", `Bearer ${organizer.accessToken}`);
      expect(selfRemove.status).toBe(400);
    }

    // Organizer removes the member
    const removed = await request(app)
      .delete(`/api/jars/${jar.id}/members/${memberId}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(removed.status).toBe(200);

    // Removed member loses access
    const jarRes = await request(app)
      .get(`/api/jars/${jar.id}`)
      .set("Authorization", `Bearer ${member.accessToken}`);
    expect([403, 404]).toContain(jarRes.status);

    // Removing again 404s (no longer active)
    const again = await request(app)
      .delete(`/api/jars/${jar.id}/members/${memberId}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(again.status).toBe(404);
  });

  it("member PATCH cannot set lifecycle status", async () => {
    const organizer = await registerUser();
    const member = await registerUser();
    const jar = await createJar(organizer.accessToken);
    const { memberId } = await inviteAndAccept(organizer.accessToken, jar.id, member);

    const res = await request(app)
      .patch(`/api/jars/${jar.id}/members/${memberId}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ status: "removed" });
    expect(res.status).toBe(400);

    // Member still has access
    const jarRes = await request(app)
      .get(`/api/jars/${jar.id}`)
      .set("Authorization", `Bearer ${member.accessToken}`);
    expect(jarRes.status).toBe(200);
  });
});

// ─── Jar settings + lifecycle guards ────────────────────────────────────────

describe("jar settings and lifecycle guards", () => {
  it("goal amount and approval threshold are locked after launch", async () => {
    const organizer = await registerUser();
    const jar = await createJar(organizer.accessToken);

    // Editable before launch
    const pre = await request(app)
      .patch(`/api/jars/${jar.id}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ goalAmountCents: 200_000 });
    expect(pre.status).toBe(200);

    await request(app)
      .post(`/api/jars/${jar.id}/launch`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .expect(200);

    const post = await request(app)
      .patch(`/api/jars/${jar.id}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ goalAmountCents: 300_000 });
    expect(post.status).toBe(400);

    // Non-financial fields remain editable after launch
    const nameEdit = await request(app)
      .patch(`/api/jars/${jar.id}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ name: "Renamed Trip" });
    expect(nameEdit.status).toBe(200);
    expect(nameEdit.body.name).toBe("Renamed Trip");
  });

  it("cancelled jars are read-only: no edits, contributions, or schedule changes", async () => {
    const organizer = await registerUser();
    const member = await registerUser();
    const jar = await createJar(organizer.accessToken);
    await inviteAndAccept(organizer.accessToken, jar.id, member);
    await request(app)
      .post(`/api/jars/${jar.id}/launch`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .expect(200);
    await request(app)
      .post(`/api/jars/${jar.id}/cancel`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .expect(200);

    const edit = await request(app)
      .patch(`/api/jars/${jar.id}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ name: "Nope" });
    expect(edit.status).toBe(400);

    const contrib = await request(app)
      .post(`/api/jars/${jar.id}/contributions`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .send({ amountCents: 1_000, contributionDate: new Date().toISOString().slice(0, 10) });
    // Standardised lifecycle refusal: 422 / JarLifecycle, shared by every
    // money-in route. Previously an undifferentiated 400.
    expect(contrib.status).toBe(422);
    expect(contrib.body.error).toBe("JarLifecycle");

    const sched = await request(app)
      .post(`/api/jars/${jar.id}/schedule`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .send({ frequency: "weekly", amountCents: 1_000, startDate: new Date().toISOString().slice(0, 10) });
    expect(sched.status).toBe(400);

    const schedPatch = await request(app)
      .patch(`/api/jars/${jar.id}/schedule`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .send({ isPaused: true });
    expect(schedPatch.status).toBe(400);
  });

  it("cancel is blocked when already cancelled", async () => {
    const organizer = await registerUser();
    const jar = await createJar(organizer.accessToken);
    await request(app)
      .post(`/api/jars/${jar.id}/cancel`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .expect(200);
    const res = await request(app)
      .post(`/api/jars/${jar.id}/cancel`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(res.status).toBe(400);
  });
});
