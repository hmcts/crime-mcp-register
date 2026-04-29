import { execSync } from 'child_process';

/**
 * Gets a GitHub token via gh CLI.
 * gh handles silent refresh automatically.
 * Only prompts developer on first use or if session fully expires.
 *
 * For hosted environments (DevOps), this is swapped for OAuth.
 */
export function getGitHubToken(): string {
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!token) throw new Error('Empty token returned from gh CLI');
    return token;
  } catch {
    throw new Error(
      '\n+==========================================+\n' +
      '|  GitHub authentication required          |\n' +
      '|  Run: gh auth login                      |\n' +
      '+==========================================+\n'
    );
  }
}
