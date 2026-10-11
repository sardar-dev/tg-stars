import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { pickUniqueCode } from "../src/params.js";

const CODE = "AAAA1111BBBB2222"; // fake

test("pickUniqueCode: single, duplicated-with-empty-first, missing, malformed", () => {
  assert.equal(pickUniqueCode({ uniquecode: CODE }), CODE);
  assert.equal(pickUniqueCode({ uniquecode: ["", CODE], pay_uid: "x" }), CODE);
  assert.equal(pickUniqueCode({ uniquecode: [CODE, "ZZZZ"] }), CODE);
  assert.equal(pickUniqueCode({ uniquecode: "" }), null);
  assert.equal(pickUniqueCode({ uniquecode: "short" }), null);
  assert.equal(pickUniqueCode({ uniquecode: "AAAA1111BBBB2222!!" }), null);
  assert.equal(pickUniqueCode({}), null);
  assert.equal(pickUniqueCode(), null);
});

test("express really parses the real redirect shape (uniquecode twice + pay_uid)", async () => {
  const app = express();
  app.get("/delivery", (req, res) => res.json({ code: pickUniqueCode(req.query) }));
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/delivery?uniquecode=&uniquecode=${CODE}&pay_uid=7FCBAAFD-6E3C-4101-9C54-BA382B3389F4`;
    const body = await (await fetch(url)).json();
    assert.deepEqual(body, { code: CODE });
  } finally {
    server.close();
  }
});
