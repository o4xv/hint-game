import test from "node:test";
import assert from "node:assert/strict";
import { redactNavigationBreadcrumb, redactRoomUrl } from "../src/session/privacy.ts";

test("redacts room codes and query strings from analytics URLs", () => {
  assert.equal(redactRoomUrl("/room/AB12?join=AB12"), "/room/:code");
  assert.equal(redactRoomUrl("/watch/ZXCV#score"), "/watch/:code");
  assert.equal(
    redactRoomUrl("https://hint.example/api/room/QWER/exists?source=test"),
    "https://hint.example/api/room/:code/exists",
  );
});

test("redacts room codes from navigation breadcrumb URLs", () => {
  assert.deepEqual(
    redactNavigationBreadcrumb({
      category: "navigation",
      data: { from: "/room/AB12?join=AB12", to: "https://hint.example/watch/ZXCV#score" },
    }),
    {
      category: "navigation",
      data: { from: "/room/:code", to: "https://hint.example/watch/:code" },
    },
  );
});
