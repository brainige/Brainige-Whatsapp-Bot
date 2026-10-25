"use strict"
/* Stub of axios for tests only — no network ever.
   The LM Studio ping reports offline; the LLM chat endpoint returns a
   CONTROLLED reply set by the test via __setReply(). */

let nextReply = ""

module.exports = {
    __setReply: (text) => { nextReply = text },
    get: async () => { const e = new Error("stub: offline"); e.code = "ECONNREFUSED"; throw e },
    post: async () => ({ data: { choices: [{ message: { content: nextReply } }] } })
}
