import { Command, EnumType, Table } from "../deps.ts";
import { MeshMarketplaceContext } from "../mesh.ts";
import { CloudFoundryContext, OsbServiceInstance, ServiceInstance } from "../osb.ts";
import { Repository } from "../repository.ts";

// see https://stackoverflow.com/questions/44480644/string-union-to-string-array for the trick used here
const ALL_FORMATS = ["text", "json"] as const;
type FormatsTuple = typeof ALL_FORMATS;
type Format = FormatsTuple[number];

const formatsType = new EnumType(ALL_FORMATS);

const ALL_PROFILES = ["meshmarketplace", "cloudfoundry"] as const;
type ProfilesTuple = typeof ALL_PROFILES;
type Profile = ProfilesTuple[number];

const profilesType = new EnumType(ALL_PROFILES);

interface ListOpts {
  profile?: Profile;
  outputFormat: Format;
  status?: Status;
  deleted?: boolean;
}

// TODO unify with statuses listed in ./update.ts
const ALL_STATUSES = ["succeeded", "failed", "in progress", "EMPTY"] as const;
type StatusesTuple = typeof ALL_STATUSES;
type Status = StatusesTuple[number];

const statusesType = new EnumType(ALL_STATUSES);

export function registerListCmd(program: Command) {
  program
    .command("list [repo]")
    .type("format", formatsType)
    .type("profile", profilesType)
    .type("status", statusesType)
    .option(
      "-p, --profile [profile:profile]",
      "include columns of context information according to the specified OSB API profile. Supported values are 'meshmarketplace' and 'cloudfoundry'. Ignored when '-o json' is set."
    )
    .option(
      "-o, --output-format [format:format]",
      "Output format. Supported formats are json and text.",
      {
        default: "text",
      }
    )
    .option(
      "--status [status:status]",
      "Filters instances by status. Allowed values are 'in progress', 'succeeded', 'failed' and 'EMPTY' (no status file present for this instance)."
    )
    .option(
      "--deleted [deleted:boolean]",
      "Filters instances by deleted. Allowed values are 'true' and 'false'"
    )
    .description(
      "Lists service instances status stored in a UniPipe OSB git repo."
    )
    .action(async (options: ListOpts, repo: string|undefined) => {
      const repository = new Repository(repo ? repo : ".");
      const out = await list(repository, options);
      console.log(out);
    });
}

export async function list(
  repo: Repository,
  opts: ListOpts
): Promise<string> {
  const filterFn = buildFilterFn(opts);

  
  switch (opts.outputFormat) {
    case "json":
      return await listJson(repo, filterFn);
    case "text":
      return await listTable(repo, filterFn, opts.profile);
  }
}

async function listJson(
  repository: Repository,
  filterFn: (instance: ServiceInstance) => boolean
): Promise<string> {
  const results = await repository.mapInstances(
    async (instance) => await instance,
    filterFn
  );

  return JSON.stringify(results);
}

async function listTable(
  repository: Repository,
  filterFn: (instance: ServiceInstance) => boolean,
  profile?: Profile
): Promise<string> {
  const results = await repository.mapInstances(async (instance) => {
    const i = instance.instance;

    const plan = instance.servicePlan;

    const pcols: string[] = profileColValues(i, profile);

    return await [
      i.serviceInstanceId,
      ...pcols,
      i.serviceDefinition.name,
      plan?.name || "",
      instance.status?.status || "",
      i.deleted === undefined ? "" : i.deleted.toString(),
    ];
  }, filterFn);

  const pcols = profileColHeaders(profile);
  const header = ["id", ...pcols, "service", "plan", "status", "deleted"];

  return new Table().header(header).body(results).toString();
}

function profileColHeaders(profile?: Profile): string[] {
  switch (profile) {
    case undefined:
      return [];
    case "meshmarketplace":
      return ["customer", "project"];
    case "cloudfoundry":
      return ["organization", "space"];
  }
}

function profileColValues(i: OsbServiceInstance, profile?: Profile): string[] {
  switch (profile) {
    case undefined:
      return [];
    case "meshmarketplace": {
      const ctx = i.context as MeshMarketplaceContext;
      return [ctx.customer_id, ctx.project_id];
    }
    case "cloudfoundry": {
      const ctx = i.context as CloudFoundryContext;
      return [ctx.organization_name, ctx.space_name];
    }
  }
}

function buildFilterFn(opts: ListOpts): (instance: ServiceInstance) => boolean {
  return (instance: ServiceInstance) => {
    const statusFilterMatches =
      !opts.status ||
      opts.status === instance.status?.status ||
      (opts.status === "EMPTY" && instance.status === null);

    const deletedFilterMatches =
      (!opts.deleted && opts.deleted !== false) ||
      opts.deleted === instance.instance.deleted;

    return deletedFilterMatches && statusFilterMatches;
  };
}
