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
} else if (starts('sts', 'assume-role')) {
  const roleArn = args[args.indexOf('--role-arn') + 1];
  if (roleArn.includes('Denied')) {
    fail(
      `An error occurred (AccessDenied) when calling the AssumeRole operation: User: arn:aws:iam::111111111111:user/alice is not authorized to perform: sts:AssumeRole on resource: ${roleArn}`,
      254,
    );
  }
  console.log(
    JSON.stringify({
      Credentials: {
        AccessKeyId: 'ROLE_KEY_ID',
        SecretAccessKey: 'ROLE_SECRET',
        SessionToken: 'ROLE_TOKEN',
        Expiration: new Date(Date.now() + 3_600_000).toISOString(),
      },
      AssumedRoleUser: { AssumedRoleId: 'AROAFAKE:session', Arn: `${roleArn.replace(':iam:', ':sts:').replace(':role/', ':assumed-role/')}/session` },
    }),
  );
} else if (starts('iam', 'list-roles')) {
  const trust = (principal) => ({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: principal, Action: 'sts:AssumeRole' }] });
  console.log(
    JSON.stringify([
      { name: 'Admin', path: '/', arn: 'arn:aws:iam::111111111111:role/Admin', description: 'Full access', created: '2024-01-02T03:04:05+00:00', maxSession: 14400, trust: trust({ AWS: 'arn:aws:iam::111111111111:root' }) },
      { name: 'lambda-exec', path: '/service-role/', arn: 'arn:aws:iam::111111111111:role/service-role/lambda-exec', description: null, created: '2024-02-03T04:05:06+00:00', maxSession: 3600, trust: trust({ Service: 'lambda.amazonaws.com' }) },
      { name: 'Partner', path: '/', arn: 'arn:aws:iam::111111111111:role/Partner', description: null, created: '2024-03-04T05:06:07+00:00', maxSession: 3600, trust: trust({ AWS: ['arn:aws:iam::222222222222:user/bob', '333333333333'], Federated: 'arn:aws:iam::111111111111:saml-provider/Corp' }) },
    ]),
  );
} else if (starts('ec2', 'describe-regions')) {
  console.log(JSON.stringify(['us-east-1', 'eu-west-1', 'ap-south-1']));
} else if (starts('lambda', 'list-functions')) {
  // One function per region, and one region closed by an organisation policy.
  const region = process.env.AWS_REGION ?? 'none';
  if (region === 'ap-south-1') {
    fail('An error occurred (AccessDeniedException) when calling the ListFunctions operation: explicit deny in a service control policy', 254);
  }
  console.log(JSON.stringify([{ name: `fn-${region}`, runtime: 'nodejs22.x', memory: 128, timeout: 3, modified: '2025-01-02T03:04:05.000+0000' }]));
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
} else if (starts('route53', 'list-hosted-zones')) {
  // Shaped like the answer after the dashboard's --query.
  console.log(
    JSON.stringify([
      { name: 'example.com.', id: '/hostedzone/Z0123456789ABCDEFGHIJ', private: false, records: 3, comment: 'Main site' },
      { name: 'corp.internal.', id: '/hostedzone/Z0999999999ZZZZZZZZZZ', private: true, records: 12, comment: null },
    ]),
  );
} else if (starts('route53', 'list-resource-record-sets')) {
  const zone = args[args.indexOf('--hosted-zone-id') + 1];
  if (zone !== 'Z0123456789ABCDEFGHIJ') {
    fail(`An error occurred (NoSuchHostedZone) when calling the ListResourceRecordSets operation: No hosted zone found with ID: ${zone}`, 254);
  }
  const plain = { ttl: null, values: null, alias: null, setId: null, weight: null, failover: null, latencyRegion: null };
  console.log(
    JSON.stringify([
      { ...plain, name: 'example.com.', type: 'A', alias: 'd111111abcdef8.cloudfront.net.' },
      { ...plain, name: 'example.com.', type: 'NS', ttl: 172800, values: ['ns-1.awsdns-01.org.', 'ns-2.awsdns-02.co.uk.'] },
      { ...plain, name: '\\052.example.com.', type: 'CNAME', ttl: 300, values: ['example.com'], setId: 'blue', weight: 80 },
    ]),
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
