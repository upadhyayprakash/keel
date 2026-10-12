import { renderText, type Block, type Keel, type Paint } from '@keel/core';
import { formatPrompt } from './terminal';

/** Shows a prompt and returns the answer, or null when the user cancelled (Ctrl+C, Ctrl+D). */
export type Ask = (prompt: string) => Promise<string | null>;

const hasError = (blocks: Block[]) => blocks.some((b) => b.kind === 'status' && b.level === 'error');

/**
 * Runs one command line. Its questions go through `ask`; without one (pipes,
 * scripts) every question is skipped. Returns the exit code.
 */
export async function runCommand(keel: Keel, line: string, paint: Paint, color: boolean, ask: Ask | null): Promise<number> {
  const print = (blocks: Block[]) => {
    if (blocks.length) process.stdout.write(renderText(blocks, color ? paint : undefined) + '\n');
  };
  let result = await keel.exec(line);
  let failed = hasError(result.blocks) || Boolean(result.failed);
  print(result.blocks);

  let lastHint: string | undefined;
  while (result.question && result.session) {
    let answer: string | null = '';
    if (ask) {
      const showHint = result.question.hint !== lastHint;
      lastHint = result.question.hint;
      answer = await ask(formatPrompt(result.question, paint, showHint));
    }
    result = await keel.answer(result.session, answer);
    failed ||= hasError(result.blocks);
    print(result.blocks);
  }
  return failed ? 1 : 0;
}
