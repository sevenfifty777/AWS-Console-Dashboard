import { describe, expect, it } from 'vitest';
import { analyseCommand, splitCommandLine, withDefaultOutput } from '../server/src/aws/commandLine';

describe('splitCommandLine', () => {
  it('splits on spaces', () => {
    expect(splitCommandLine('  s3   ls  ')).toEqual(['s3', 'ls']);
  });

  it('keeps quoted text together and drops the quotes', () => {
    expect(splitCommandLine(`ec2 describe-instances --filters "Name=tag:Name,Values=my server"`)).toEqual([
      'ec2',
      'describe-instances',
      '--filters',
      'Name=tag:Name,Values=my server',
    ]);
    expect(splitCommandLine(`--query 'Reservations[].Instances[?State.Name==\`running\`]'`)).toEqual([
      '--query',
      'Reservations[].Instances[?State.Name==`running`]',
    ]);
  });

  it('accepts JSON in single quotes or with escaped double quotes', () => {
    expect(splitCommandLine(`--item '{"id": {"S": "1"}}'`)).toEqual(['--item', '{"id": {"S": "1"}}']);
    expect(splitCommandLine(`--item "{\\"id\\": 1}"`)).toEqual(['--item', '{"id": 1}']);
  });

  it('leaves Windows paths and empty quotes alone', () => {
    expect(splitCommandLine(`s3 cp C:\\temp\\file.txt s3://bucket/ --metadata ""`)).toEqual([
      's3',
      'cp',
      'C:\\temp\\file.txt',
      's3://bucket/',
      '--metadata',
      '',
    ]);
  });

  it('joins lines ending in a continuation character', () => {
    expect(splitCommandLine('ec2 describe-instances `\r\n  --region eu-west-1 \\\n  --max-items 5')).toEqual([
      'ec2',
      'describe-instances',
      '--region',
      'eu-west-1',
      '--max-items',
      '5',
    ]);
  });

  it('treats shell operators as plain text', () => {
    expect(splitCommandLine('s3 ls | findstr x && del y > out.txt')).toEqual(['s3', 'ls', '|', 'findstr', 'x', '&&', 'del', 'y', '>', 'out.txt']);
  });

  it('rejects an unclosed quote', () => {
    expect(() => splitCommandLine('s3 ls "bucket')).toThrow(/unclosed/);
  });
});

describe('analyseCommand', () => {
  const readOnly = (command: string) => analyseCommand(command).readOnly;

  it('drops a leading aws', () => {
    expect(analyseCommand('aws s3 ls').args).toEqual(['s3', 'ls']);
    expect(analyseCommand('AWS.EXE s3 ls').args).toEqual(['s3', 'ls']);
  });

  it.each([
    's3 ls',
    'ec2 describe-instances --region eu-west-1',
    '--region eu-west-1 ec2 describe-instances',
    'sts get-caller-identity',
    'configure list',
    'logs tail /aws/lambda/x --follow',
    'dynamodb scan --table-name t',
    '--version',
    'ec2 help',
    'help',
  ])('treats "%s" as read-only', (command) => {
    expect(readOnly(command)).toBe(true);
    expect(analyseCommand(command).blocked).toBeUndefined();
  });

  it.each([
    's3 rm s3://bucket/key',
    's3 cp a.txt s3://bucket/',
    'ec2 terminate-instances --instance-ids i-123',
    '--region eu-west-1 ec2 terminate-instances --instance-ids i-123',
    'lambda invoke --function-name f out.json',
    'iam create-user --user-name bob',
    'configure set region eu-west-1',
    'cloudformation deploy --stack-name s --template-file t.yml',
  ])('asks for confirmation before "%s"', (command) => {
    const check = analyseCommand(command);
    expect(check.readOnly).toBe(false);
    expect(check.blocked).toBeUndefined();
  });

  it.each([
    '',
    'aws',
    'configure',
    'configure sso',
    'configure export-credentials --format process',
    'configure get aws_secret_access_key',
    'sso login --profile x',
    'login',
    'logout --profile x',
    'ssm start-session --target i-123',
    'ecs execute-command --cluster c --task t --interactive --command sh',
    's3 ls "unclosed',
  ])('refuses "%s" with an explanation', (command) => {
    const check = analyseCommand(command);
    expect(check.blocked).toBeTruthy();
    expect(check.readOnly).toBe(false);
  });
});

describe('withDefaultOutput', () => {
  it('adds JSON output to service commands', () => {
    expect(withDefaultOutput(['ec2', 'describe-instances'])).toEqual(['ec2', 'describe-instances', '--output', 'json']);
  });

  it('leaves commands alone when a format is chosen or the output is plain text', () => {
    for (const args of [
      ['ec2', 'describe-instances', '--output', 'table'],
      ['ec2', 'describe-instances', '--output=text'],
      ['s3', 'ls'],
      ['configure', 'list'],
      ['ec2', 'help'],
      ['ec2', 'describe-instances', 'help'],
      ['ec2', 'wait', 'instance-running'],
      ['logs', 'tail', 'group'],
      ['--version'],
    ]) {
      expect(withDefaultOutput(args)).toEqual(args);
    }
  });
});
