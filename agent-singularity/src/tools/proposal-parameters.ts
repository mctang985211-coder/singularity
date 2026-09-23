/**
 * The proposal tools' argument closure (T2/T3 stage C).
 *
 * A DSH tool's parameter map is an implicitly **open** object root
 * (`tools/schema.ts`: "The map itself is an implicit open object root"), so the
 * schema cannot refuse a key a tool does not declare — which is deliberate for
 * `task_decompose`, whose whole batch is handed to the runtime to refuse field
 * by field. The three proposal tools have the opposite need: their entire
 * contract is "a proposal id and nothing else", and in particular there is no
 * argument anywhere that could mean "approved". A caller that tries one — a
 * model inventing `approved: true`, or any other approval credential — must be
 * told *by name* that this tool has no such parameter, instead of having the
 * value silently ignored while the call runs as if it had been accepted.
 *
 * The check is the tool's own and runs before any service call, so a refused
 * call has no side effect at all (§6: 服务入口执行所有检查；工具层只是显示与发起请求).
 * @module dsh-singularity-agent/tools/proposal-parameters
 */

/**
 * Refuse a call that carries a key the tool does not declare.
 * @param args - the parsed arguments, as the model sent them.
 * @param declared - every parameter the tool declares.
 * @param toolName - the tool's own name, for the refusal text.
 * @returns the refusal text, or `undefined` when the call carries nothing undeclared.
 */
export function undeclaredParameters(
  args: Record<string, unknown>,
  declared: readonly string[],
  toolName: string,
): string | undefined {
  const undeclared = Object.keys(args).filter(key => !declared.includes(key))
  if (undeclared.length === 0) return undefined
  return [
    `${toolName} rejected: undeclared parameter${undeclared.length === 1 ? '' : 's'} ${undeclared.map(key => `"${key}"`).join(', ')} —`,
    `this tool accepts ${declared.join(', ')} and has no argument that approves, decides, or stands in for a review;`,
    'nothing was read and nothing was changed.',
  ].join(' ')
}
