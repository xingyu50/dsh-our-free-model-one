import fs from 'node:fs'

/**
 * Delete a test fixture's scratch directory without failing the suite over it.
 *
 * ## What was observed
 *
 * `magpie-policy` twice ended a full run with every check printed `ok` and then
 * exited 1 from its `finally`, on `fs.rmSync(scratch)`:
 *
 *     Error: EPERM, Permission denied: \\?\C:\...\Temp\ofm-magpie-policy-9ihBCl
 *
 * The same `%TEMP%` holds `ofm-magpie-*` directories from 10-26, 10-27 and
 * 10-28 — the race is older than anything reviewed here.
 *
 * ## What could not be established
 *
 * Not reproduced in isolation: eight rounds of the suite's exact lifecycle
 * (engine + front server + `engine.proxy` + real fetches + close in the same
 * order), eight rounds of plain `engine.start()`/`close()`, and thirty rounds
 * of "child exits, then delete the directory it was standing in" all came back
 * clean on this machine. So the mechanism is unproven — on Windows the error
 * names the directory and never the handle, and by the time it is thrown the
 * engine has already exited. What is certain is that the suite's assertions were
 * done, that the failure was in housekeeping, and that it made a green run
 * report red.
 *
 * ## Why retry rather than wait longer
 *
 * A leftover directory is worth less than the suite's verdict, and none of the
 * candidates for "who still holds it" — a process tree the fixture does not own,
 * a filesystem filter, an editor's indexer — is something a test can cleanly
 * await. `fs.rmSync`'s own `maxRetries` does not help either: measured, a
 * directory held as another process's cwd never becomes deletable inside that
 * budget, while an unlink failure is retried correctly. So the outer loop is
 * short, and the last attempt prints the path instead of throwing — the next
 * occurrence then has a name attached to it.
 *
 * @param {string} dir
 * @param {{attempts?: number, delayMs?: number, warn?: (message: string) => void}} [options]
 * @returns {Promise<boolean>} whether the directory is gone
 */
export async function removeScratch(dir, options = {}) {
  const attempts = options.attempts ?? 12
  const delayMs = options.delayMs ?? 150
  const warn = options.warn ?? (message => console.warn(message))
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return true
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EBUSY' && error.code !== 'ENOTEMPTY') throw error
      if (attempt === attempts) {
        warn(`removeScratch: ${dir} is still held (${error.code}) after ${attempts} attempts — leaving it behind`)
        return false
      }
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  return false
}
