import { db } from '../db.ts';
import { streamToRun } from '../claude.ts';
import type { ServerModule } from './types.ts';

const ASK_SYSTEM = `You are the assistant inside OFSD Terminal, a private research workspace for a markets-focused user.
Answer in plain text for a narrow terminal log: short paragraphs, simple dashes for lists, no markdown headers, no tables.
Be direct and specific. If you are not sure about a number or a recent fact, say so instead of guessing.`;

/** Core module: free-form questions to Claude. Plain text without a slash also lands here. */
export const terminal: ServerModule = {
  id: 'terminal',
  title: 'Terminal',
  commands: {
    ask: {
      description: 'Ask Claude anything. Plain text without a slash does the same.',
      run: async (args, run) => {
        const question = args.trim();
        if (!question) {
          run.fail('Type a question after /ask, for example: /ask what moves the 2s10s curve?');
          return;
        }
        // Short memory: the last few answered questions, so follow-ups make sense.
        const recent = db
          .prepare(
            `SELECT r.command, (SELECT group_concat(json_extract(e.data, '$.delta'), '') FROM run_events e
               WHERE e.run_id = r.id AND e.type = 'text') AS answer
             FROM runs r WHERE r.module = 'terminal' AND r.status = 'done' AND r.id != ?
             ORDER BY r.created_at DESC LIMIT 4`,
          )
          .all(run.id) as Array<{ command: string; answer: string | null }>;
        const history = recent
          .reverse()
          .filter((r) => r.answer)
          .flatMap((r) => [
            { role: 'user' as const, content: r.command.replace(/^\/ask\s+/i, '') },
            { role: 'assistant' as const, content: r.answer! },
          ]);
        await streamToRun(run, { system: ASK_SYSTEM, messages: [...history, { role: 'user', content: question }] });
        run.end('done');
      },
    },
  },
  records: () => 0,
};
