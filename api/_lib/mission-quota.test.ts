import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkMissionQuota, incrementMissionQuota } from './runs';
import type { UserScope } from './db';
import type { ProfileDoc } from '../../shared/schemas';

// A minimal in-memory stand-in for forUser(uid) holding a single profile doc.
// Only the surface the quota functions touch is implemented: profiles.findOne
// and profiles.updateOne (the `{}` filter resolves to "this user's profile").
function fakeScope(profile: Partial<ProfileDoc> | null): { scope: UserScope; get: () => Partial<ProfileDoc> | null } {
  let doc = profile;
  const profiles = {
    async findOne() {
      return doc as any;
    },
    async updateOne(_filter: unknown, update: Partial<ProfileDoc>) {
      if (!doc) return 0;
      doc = { ...doc, ...update };
      return 1;
    },
  };
  const scope = {
    uid: 'u1',
    collection: () => profiles as any,
  } as unknown as UserScope;
  return { scope, get: () => doc };
}

// Captures the HTTP status/body a 429 would write.
function fakeRes() {
  const out: { status?: number; body?: any } = {};
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: any) {
      out.body = body;
      return this;
    },
  };
  return { res: res as any, out };
}

const period = (() => {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}`;
})();

describe('mission quota (delete-proof monthly cap)', () => {
  it('allows launches under the free cap and 429s at the limit', async () => {
    // Free tier = 3 missions/month. Profile already used 2 this month.
    const { scope } = fakeScope({ missionQuota: { period, used: 2 } });
    const a = fakeRes();
    assert.equal(await checkMissionQuota(scope, a.res), true); // 3rd allowed
    assert.equal(a.out.status, undefined);

    const { scope: full } = fakeScope({ missionQuota: { period, used: 3 } });
    const b = fakeRes();
    assert.equal(await checkMissionQuota(full, b.res), false); // at cap
    assert.equal(b.out.status, 429);
    assert.equal(b.out.body.error, 'mission_quota_exceeded');
  });

  it('treats an absent counter and a stale (prior-month) counter as 0 used', async () => {
    const fresh = fakeScope({ name: null }); // profile exists, no missionQuota yet
    const r1 = fakeRes();
    assert.equal(await checkMissionQuota(fresh.scope, r1.res), true);

    const stale = fakeScope({ missionQuota: { period: '2000-01', used: 99 } });
    const r2 = fakeRes();
    assert.equal(await checkMissionQuota(stale.scope, r2.res), true);
  });

  it('increment is monotonic and a delete (no decrement) cannot refund quota', async () => {
    const { scope, get } = fakeScope({ missionQuota: { period, used: 2 } });
    // Create the 3rd mission → counter hits the cap.
    await incrementMissionQuota(scope);
    assert.deepEqual(get()!.missionQuota, { period, used: 3 });

    // Deleting a mission does NOT touch the counter (there is no decrement path).
    // So a follow-up create is still blocked - no infinite-missions loophole.
    const r = fakeRes();
    assert.equal(await checkMissionQuota(scope, r.res), false);
    assert.equal(r.out.status, 429);
  });

  it('resets the counter at a month boundary', async () => {
    const { scope, get } = fakeScope({ missionQuota: { period: '2000-01', used: 3 } });
    await incrementMissionQuota(scope);
    assert.deepEqual(get()!.missionQuota, { period, used: 1 });
  });
});
