export interface PushDecisionInput {
  toolName: string;
  command?: string;
  // Both in ms since the epoch.
  now: number;
  lastPushAt?: number;
  minIntervalS: number;
}
export declare function isTestRun(command: string): boolean;
export declare function shouldPush(input: PushDecisionInput): boolean;
export declare function commitMessage(agent: string, files: readonly string[]): string;
export declare function agentFromAuthor(authorName: string | undefined): string;
