// Stand-in for the AWS CLI, used by the tests through AWS_DASHBOARD_CLI.
// It answers a handful of commands the way the real CLI does, including the
// error texts for an expired SSO session and for a role without permission.
const args = process.argv.slice(2);
const profile = process.env.AWS_PROFILE ?? 'default';
const starts = (...words) => words.every((word, index) => args[index] === word);

function fail(message, code = 255) {
  process.stderr.write(`\n${message}\n`);
  process.exit(code);
}

if (args[0] === '--version') {
  console.log('aws-cli/2.99.0 fake');
} else if (profile.includes('expired')) {
  fail('Error when retrieving token from sso: Token has expired and refresh failed');
} else if (starts('sts', 'get-caller-identity')) {
  console.log(
    JSON.stringify({
      UserId: 'AIDAFAKEFAKEFAKE',
      Account: '111111111111',
      Arn: `arn:aws:iam::111111111111:user/${profile}`,
    }),
  );
} else if (starts('s3api', 'list-buckets')) {
  const buckets = [
    { name: 'logs-bucket', region: 'eu-west-1', created: '2024-01-02T03:04:05+00:00' },
    { name: 'assets-bucket', region: 'us-east-1', created: '2025-06-07T08:09:10+00:00' },
  ];
  // With --query the real CLI returns the shaped rows; without it, the raw answer.
  console.log(JSON.stringify(args.includes('--query') ? buckets : { Buckets: buckets }));
} else if (starts('ec2', 'describe-instances')) {
  fail(
    'An error occurred (UnauthorizedOperation) when calling the DescribeInstances operation: You are not authorized to perform this operation.',
    254,
  );
} else if (starts('sleep')) {
  // Never finishes by itself: used to test the time limit and cancelling.
  setTimeout(() => {}, 60_000);
} else if (starts('print-env')) {
  console.log(
    JSON.stringify({
      profile: process.env.AWS_PROFILE ?? null,
      region: process.env.AWS_REGION ?? null,
      accessKey: process.env.AWS_ACCESS_KEY_ID ?? null,
      pager: process.env.AWS_PAGER ?? null,
    }),
  );
} else {
  fail(`fake aws: unsupported command: ${args.join(' ')}`, 2);
}
