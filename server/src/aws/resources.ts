import type { ResourceInfo } from '../../../shared/types';

/**
 * A resource view is one read-only CLI call plus a JMESPath query that shapes the
 * answer into flat rows. To add a service, add an entry here; nothing else changes.
 */
export interface ResourceDef extends ResourceInfo {
  /** CLI arguments, without --query and --output. */
  args: string[];
  /** JMESPath query returning a list of objects whose keys match the columns. */
  query: string;
  /**
   * For a view opened from a row of another view: the CLI option that receives the
   * value taken from that row, and what a valid value looks like.
   */
  param?: { option: string; pattern: RegExp };
  /** Tidies one row after the CLI answered, for what JMESPath cannot express. */
  mapRow?: (row: Record<string, unknown>) => Record<string, unknown>;
}

/** Route 53 writes special characters as octal escapes (\052 is "*") and ends names with a dot. */
function dnsName(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/\\(\d{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8))).replace(/\.$/, '');
}

/**
 * Sums up the trust policy of a role: who is allowed to assume it.
 * serviceOnly is true when only AWS services can, so a person cannot switch to it.
 */
function trustSummary(policy: unknown): { text: string; serviceOnly: boolean } {
  const raw = (policy as { Statement?: unknown } | null)?.Statement;
  const statements = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const parts = new Set<string>();
  let nonService = false;

  for (const statement of statements as { Effect?: string; Principal?: unknown }[]) {
    if (statement?.Effect !== 'Allow') continue;
    if (statement.Principal === '*') {
      parts.add('Anyone');
      nonService = true;
      continue;
    }
    for (const [kind, value] of Object.entries((statement.Principal ?? {}) as Record<string, unknown>)) {
      for (const principal of Array.isArray(value) ? value : [value]) {
        if (typeof principal !== 'string') continue;
        if (kind === 'Service') {
          parts.add(`Service ${principal.replace(/\.amazonaws\.com$/, '')}`);
          continue;
        }
        nonService = true;
        const arn = /^arn:[^:]*:(?:iam|sts)::(\d{12}):(.+)$/.exec(principal);
        if (kind === 'AWS' && arn) parts.add(arn[2] === 'root' ? `Account ${arn[1]}` : `${arn[2]} in ${arn[1]}`);
        else if (kind === 'AWS' && /^\d{12}$/.test(principal)) parts.add(`Account ${principal}`);
        else if (kind === 'Federated') parts.add(`Federated ${principal.split('/').pop()}`);
        else parts.add(`${kind} ${principal}`);
      }
    }
  }
  return { text: [...parts].join('\n'), serviceOnly: parts.size > 0 && !nonService };
}

export const RESOURCES: ResourceDef[] = [
  {
    id: 'ec2',
    title: 'EC2 instances',
    global: false,
    args: ['ec2', 'describe-instances'],
    query:
      "Reservations[].Instances[].{id:InstanceId,name:Tags[?Key=='Name']|[0].Value,state:State.Name,type:InstanceType,az:Placement.AvailabilityZone,privateIp:PrivateIpAddress,publicIp:PublicIpAddress,launched:LaunchTime}",
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'id', label: 'Instance ID' },
      { key: 'state', label: 'State' },
      { key: 'type', label: 'Type' },
      { key: 'az', label: 'Zone' },
      { key: 'privateIp', label: 'Private IP' },
      { key: 'publicIp', label: 'Public IP' },
      { key: 'launched', label: 'Launched' },
    ],
  },
  {
    id: 's3',
    title: 'S3 buckets',
    global: true,
    args: ['s3api', 'list-buckets'],
    query: 'Buckets[].{name:Name,created:CreationDate}',
    columns: [
      { key: 'name', label: 'Bucket' },
      { key: 'created', label: 'Created' },
    ],
  },
  {
    id: 'lambda',
    title: 'Lambda functions',
    global: false,
    args: ['lambda', 'list-functions'],
    query: 'Functions[].{name:FunctionName,runtime:Runtime,memory:MemorySize,timeout:Timeout,modified:LastModified}',
    columns: [
      { key: 'name', label: 'Function' },
      { key: 'runtime', label: 'Runtime' },
      { key: 'memory', label: 'Memory (MB)' },
      { key: 'timeout', label: 'Timeout (s)' },
      { key: 'modified', label: 'Last modified' },
    ],
  },
  {
    id: 'rds',
    title: 'RDS instances',
    global: false,
    args: ['rds', 'describe-db-instances'],
    query:
      'DBInstances[].{id:DBInstanceIdentifier,engine:Engine,version:EngineVersion,class:DBInstanceClass,status:DBInstanceStatus,az:AvailabilityZone,endpoint:Endpoint.Address}',
    columns: [
      { key: 'id', label: 'Instance' },
      { key: 'engine', label: 'Engine' },
      { key: 'version', label: 'Version' },
      { key: 'class', label: 'Class' },
      { key: 'status', label: 'Status' },
      { key: 'az', label: 'Zone' },
      { key: 'endpoint', label: 'Endpoint' },
    ],
  },
  {
    id: 'cloudformation',
    title: 'CloudFormation stacks',
    global: false,
    args: ['cloudformation', 'describe-stacks'],
    query: 'Stacks[].{name:StackName,status:StackStatus,created:CreationTime,updated:LastUpdatedTime,description:Description}',
    columns: [
      { key: 'name', label: 'Stack' },
      { key: 'status', label: 'Status' },
      { key: 'created', label: 'Created' },
      { key: 'updated', label: 'Updated' },
      { key: 'description', label: 'Description' },
    ],
  },
  {
    id: 'alarms',
    title: 'CloudWatch alarms',
    global: false,
    args: ['cloudwatch', 'describe-alarms'],
    query: 'MetricAlarms[].{name:AlarmName,state:StateValue,metric:MetricName,namespace:Namespace,updated:StateUpdatedTimestamp}',
    columns: [
      { key: 'name', label: 'Alarm' },
      { key: 'state', label: 'State' },
      { key: 'metric', label: 'Metric' },
      { key: 'namespace', label: 'Namespace' },
      { key: 'updated', label: 'State changed' },
    ],
  },
  {
    id: 'route53',
    title: 'Route 53 hosted zones',
    global: true,
    args: ['route53', 'list-hosted-zones'],
    query: 'HostedZones[].{name:Name,id:Id,private:Config.PrivateZone,records:ResourceRecordSetCount,comment:Config.Comment}',
    columns: [
      { key: 'name', label: 'Domain' },
      { key: 'id', label: 'Zone ID' },
      { key: 'visibility', label: 'Visibility' },
      { key: 'records', label: 'Records' },
      { key: 'comment', label: 'Comment' },
    ],
    mapRow: ({ private: isPrivate, ...row }) => ({
      ...row,
      name: dnsName(row.name),
      id: String(row.id ?? '').replace(/^\/hostedzone\//, ''),
      visibility: isPrivate ? 'Private' : 'Public',
    }),
    drill: { view: 'route53-records', paramKey: 'id', titleKey: 'name', label: 'Records' },
  },
  {
    id: 'route53-records',
    title: 'Route 53 records',
    global: true,
    parent: 'route53',
    args: ['route53', 'list-resource-record-sets'],
    param: { option: '--hosted-zone-id', pattern: /^[A-Z0-9]{1,32}$/ },
    query:
      'ResourceRecordSets[].{name:Name,type:Type,ttl:TTL,values:ResourceRecords[].Value,alias:AliasTarget.DNSName,setId:SetIdentifier,weight:Weight,failover:Failover,latencyRegion:Region}',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'type', label: 'Type' },
      { key: 'ttl', label: 'TTL (s)' },
      { key: 'value', label: 'Value' },
      { key: 'routing', label: 'Routing' },
    ],
    mapRow: ({ values, alias, setId, weight, failover, latencyRegion, ...row }) => ({
      ...row,
      name: dnsName(row.name),
      // An alias record points at another AWS resource and has no values of its own.
      value: alias ? `Alias to ${String(dnsName(alias))}` : Array.isArray(values) ? values.join('\n') : '',
      // Only set for weighted, failover or latency records.
      routing: [setId, typeof weight === 'number' ? `weight ${weight}` : null, failover, latencyRegion].filter(Boolean).join(' · '),
    }),
  },
  {
    // Shown by the IAM roles page, where a row can be switched to.
    id: 'iam-roles',
    title: 'IAM roles',
    global: true,
    hidden: true,
    args: ['iam', 'list-roles'],
    query:
      'Roles[].{name:RoleName,path:Path,arn:Arn,description:Description,created:CreateDate,maxSession:MaxSessionDuration,trust:AssumeRolePolicyDocument}',
    columns: [
      { key: 'name', label: 'Role' },
      { key: 'trustedBy', label: 'Who can use it' },
      { key: 'description', label: 'Description' },
      { key: 'maxHours', label: 'Longest session (h)' },
      { key: 'created', label: 'Created' },
    ],
    mapRow: ({ trust, maxSession, ...row }) => {
      const summary = trustSummary(trust);
      return {
        ...row,
        trustedBy: summary.text,
        serviceOnly: summary.serviceOnly,
        maxHours: typeof maxSession === 'number' ? maxSession / 3600 : null,
      };
    },
  },
];
