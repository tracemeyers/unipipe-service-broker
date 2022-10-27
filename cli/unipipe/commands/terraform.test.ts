import { path } from "../deps.ts";
import { assertEquals, returnsNext, Stub, stub } from "../dev_deps.ts";
import { Repository } from "../repository.ts";
import { withTempDir } from "../test-util.ts";
import { run } from "./terraform.ts";

const SERVICE_DEFINITION_ID = "777";
const SERVICE_INSTANCE_ID = "123";
const SERVICE_BINDING_ID = "456";

const TF_MODULE = {
  variable: {
    platform_secret: {
      description:
        "The secret that will be used by Terraform to authenticate against the cloud platform.",
      type: "string",
      sensitive: true,
    },
  },
  module: {
    wrapper: {
      source: "../../../../terraform/" + SERVICE_DEFINITION_ID,
      platform_secret: "${var.platform_secret}",
      platform: "dev.azure",
      project_id: "my-project",
      customer_id: "my-customer",
      myParam: "test",
      tenant_id: "my-tenant",
    },
  },
}

const TF_MODULE_CONTENT = JSON.stringify(
  TF_MODULE,
  null,
  2,
);

async function assertContent(pathComponents: string[], expected: string) {
  const result = await Deno.readTextFile(path.join(...pathComponents));

  assertEquals(result, expected);
}

Deno.test(
  "does nothing for empty repository",
  async () =>
    await withTempDir(async (tmp) => {
      const result = await run(new Repository(tmp), {});

      await assertEquals(result, []);
    }),
);

Deno.test(
  "skips instances with missing terraform folder for service definition",
  async () =>
    await withTempDir(async (tmp) => {
      createInstanceAndBinding(tmp);

      const result = await run(new Repository(tmp), {});

      await assertEquals(result, [[
        `${SERVICE_INSTANCE_ID}/${SERVICE_BINDING_ID}: skipped`,
      ]]);
    }),
);

Deno.test(
  "sets instance without bindings to successful as nothing needs to be executed",
  async () =>
    await withTempDir(async (tmp) => {
      createInstance(tmp);

      const result = await run(new Repository(tmp), {});

      await assertEquals(result, [[
        `${SERVICE_INSTANCE_ID}: succeeded`,
      ]]);

      const expectedStatus =
        "status: succeeded\ndescription: Instance without binding processed successfully. No action executed.\n";

      await assertContent(
        [tmp, `/instances/${SERVICE_INSTANCE_ID}/status.yml`],
        expectedStatus,
      );
    }),
);

Deno.test(
  "can handle successful terraform execution",
  async () =>
    await withTempDir(async (tmp) => {
      createInstanceAndBinding(tmp);
      createTerraformServiceFolder(tmp);

      const stub = mockTerraformExecution();

      const result = await run(new Repository(tmp), {});

      await assertEquals(result, [[
        `${SERVICE_INSTANCE_ID}/${SERVICE_BINDING_ID}: successful`,
      ]]);

      const expectedStatus =
        "status: succeeded\ndescription: Terraform applied successfully\n";

      await verifyStatusAndTfModuleFileContent(tmp, expectedStatus);

      stub.restore();
    }),
);

Deno.test(
  "can handle failed terraform execution",
  async () =>
    await withTempDir(async (tmp) => {
      createInstanceAndBinding(tmp);
      createTerraformServiceFolder(tmp);

      const stub = mockTerraformExecution(false);

      const result = await run(new Repository(tmp), {});

      await assertEquals(result, [[
        `${SERVICE_INSTANCE_ID}/${SERVICE_BINDING_ID}: failed`,
      ]]);

      const expectedStatus =
        "status: failed\ndescription: Applying Terraform failed!\n";

      await verifyStatusAndTfModuleFileContent(tmp, expectedStatus);
      stub.restore();
    }),
);

Deno.test(
  "can handle error during processing",
  async () =>
    await withTempDir(async (tmp) => {
      createInstanceAndBinding(tmp);
      createTerraformServiceFolder(tmp);

      const runStub = stub(
        Deno,
        "run",
        returnsNext([new Error("failed!")]),
      );

      const result = await run(new Repository(tmp), {});

      await assertEquals(result, [[
        `${SERVICE_INSTANCE_ID}/${SERVICE_BINDING_ID}: failed`,
      ]]);

      const expectedStatus =
        "status: failed\ndescription: Processing the binding failed!\n";

      await verifyStatusAndTfModuleFileContent(tmp, expectedStatus);
      runStub.restore();
    }),
);

Deno.test(
  "puts instance and binding to pending if manual instance parameters needed and not there yet",
  async () =>
    await withTempDir(async (tmp) => {
      createInstanceAndBinding(tmp, true);

      const result = await run(new Repository(tmp), {});

      await assertEquals(result, [[
        `${SERVICE_INSTANCE_ID}/${SERVICE_BINDING_ID}: pending`,
      ]]);

      const expectedStatus =
        "status: in progress\ndescription: Waiting for manual input from a platform operator!\n";

      await verifyInstanceAndBindingStatus(tmp, expectedStatus);
    }),
);

Deno.test(
  "succeeds if manual instance parameters needed and they are available",
  async () =>
    await withTempDir(async (tmp) => {
      createInstanceAndBinding(tmp, true);
      createTerraformServiceFolder(tmp);
      createManualInstanceParams(tmp);

      const stub = mockTerraformExecution();

      const result = await run(new Repository(tmp), {});

      await assertEquals(result, [[
        `${SERVICE_INSTANCE_ID}/${SERVICE_BINDING_ID}: successful`,
      ]]);

      const expectedStatus =
        "status: succeeded\ndescription: Terraform applied successfully\n";

      const tfModuleContent = JSON.parse(TF_MODULE_CONTENT);
      tfModuleContent.module.wrapper.manualParam = "test"

      await verifyStatusAndTfModuleFileContent(tmp, expectedStatus, JSON.stringify(tfModuleContent, null, 2));
      stub.restore();
    }),
);

function mockTerraformExecution(success = true): Stub {
  const mockResult = {
    status: () => {
      return {
        success: success,
        code: 0,
        signal: undefined,
      };
    },
  };

  return stub(
    Deno,
    "run",
    returnsNext([mockResult, mockResult]),
  );
}

function createTerraformServiceFolder(repoDir: string) {
  Deno.mkdirSync(repoDir + "/terraform/" + SERVICE_DEFINITION_ID, {
    recursive: true,
  });
}

function createInstanceAndBinding(
  repoDir: string,
  manualInstanceInputNeeded = false,
) {
  createInstance(repoDir, manualInstanceInputNeeded);
  createBinding(repoDir);
}

function createInstance(repoDir: string, manualInstanceInputNeeded = false) {
  Deno.mkdirSync(
    repoDir + `/instances/${SERVICE_INSTANCE_ID}`,
    { recursive: true },
  );
  Deno.writeTextFileSync(
    repoDir + `/instances/${SERVICE_INSTANCE_ID}/instance.yml`,
    JSON.stringify(
      {
        serviceInstanceId: SERVICE_INSTANCE_ID,
        serviceDefinitionId: SERVICE_DEFINITION_ID,
        planId: "plan456",
        serviceDefinition: {
          plans: [{
            id: "plan123",
            metadata: {
              manualInstanceInputNeeded: true,
            },
          },{
            id: "plan456",
            metadata: {
              manualInstanceInputNeeded: manualInstanceInputNeeded,
            },
          },]
        },
        parameters: {
          myParam: "test",
        },
        context: {
          platform: "dev.azure",
          project_id: "my-project",
          customer_id: "my-customer",
          auth_url: "should-be-ignored",
        },
      },
      null,
      2,
    ),
  );
}

function createManualInstanceParams(repoDir: string) {
  Deno.writeTextFileSync(
    repoDir + `/instances/${SERVICE_INSTANCE_ID}/params.yml`,
    JSON.stringify(
      {
        manualParam: "test",
      },
      null,
      2,
    ),
  );
}

function createBinding(repoDir: string) {
  Deno.mkdirSync(
    repoDir +
      `/instances/${SERVICE_INSTANCE_ID}/bindings/${SERVICE_BINDING_ID}`,
    { recursive: true },
  );
  Deno.writeTextFileSync(
    repoDir +
      `/instances/${SERVICE_INSTANCE_ID}/bindings/${SERVICE_BINDING_ID}/binding.yml`,
    JSON.stringify(
      {
        bindingId: SERVICE_BINDING_ID,
        serviceInstanceId: SERVICE_INSTANCE_ID,
        serviceDefinitionId: SERVICE_DEFINITION_ID,
        parameters: {},
        bindResource: {
          tenant_id: "my-tenant",
          platform: "dev.azure",
        },
      },
      null,
      2,
    ),
  );
}

async function verifyStatusAndTfModuleFileContent(
  repoDir: string,
  expectedStatus: string,
  expectedTfModuleContent = TF_MODULE_CONTENT,
) {
  await verifyInstanceAndBindingStatus(repoDir, expectedStatus);

  await assertContent(
    [
      repoDir,
      `/instances/${SERVICE_INSTANCE_ID}/bindings/${SERVICE_BINDING_ID}/module.tf.json`,
    ],
    expectedTfModuleContent,
  );
}

async function verifyInstanceAndBindingStatus(
  repoDir: string,
  expectedStatus: string,
) {
  await assertContent(
    [repoDir, `/instances/${SERVICE_INSTANCE_ID}/status.yml`],
    expectedStatus,
  );

  await assertContent(
    [
      repoDir,
      `/instances/${SERVICE_INSTANCE_ID}/bindings/${SERVICE_BINDING_ID}/status.yml`,
    ],
    expectedStatus,
  );
}
