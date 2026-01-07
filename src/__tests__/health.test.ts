import request from "supertest";
import { app } from "../main.js";

describe("GET /health", () => {
  it("should return 200 and status OK", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "OK" });
  });
});
