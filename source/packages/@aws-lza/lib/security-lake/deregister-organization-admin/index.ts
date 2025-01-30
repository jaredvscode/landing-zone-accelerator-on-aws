/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import path from 'path';

import { createLogger } from '../../../common/logger';
import { ISecurityLakeHandlerParameter, ISecurityLakeModuleAction } from '../../../interfaces/security-lake';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { setRetryStrategy } from '../../../common/functions';
import { DeregisterDataLakeDelegatedAdministratorCommand, SecurityLakeClient } from '@aws-sdk/client-securitylake';
import { throttlingBackOff } from '../../../common/throttle';
import { getOrganizationDelegatedAdminAccountId } from '../../../common/resources';

/**
 * Enum for DeregisterOrganizationAdmin operation action types.
 */
enum SecurityLakeOrganizationAdminActionType {
  DEREGISTER_DELEGATED_ADMIN,
  DEREGISTER_SKIPPED,
}

/**
 * DeregisterOrganizationAdmin class to manage Amazon Security Lake
 * set organization Admin operation.
 */
export class DeregisterOrganizationAdmin implements ISecurityLakeModuleAction {
  private logger = createLogger([path.parse(path.basename(__filename)).name]);
  /**
   * Handler function to manage Amazon Security Lake delegated admin.
   *
   * @param props {@link ISecurityLakeHandlerParameter}
   * @returns status string
   */
  public async handler(props: ISecurityLakeHandlerParameter): Promise<string> {
    const organizationClient = new OrganizationsClient({
      region: props.homeRegion,
      customUserAgent: props.solutionId,
      retryStrategy: setRetryStrategy(),
      credentials: props.credentials,
    });

    const currentAdmin = await getOrganizationDelegatedAdminAccountId(organizationClient, 'securitylake.amazon.com');

    const securityLakeClient = new SecurityLakeClient({
      region: props.homeRegion,
      customUserAgent: props.solutionId,
      retryStrategy: setRetryStrategy(),
      credentials: props.credentials,
    });

    if (!currentAdmin) {
      return this.generateStatusMessage(SecurityLakeOrganizationAdminActionType.DEREGISTER_SKIPPED, !!props.dryRun);
    }

    if (!props.dryRun) {
      this.deregisterDelegatedAdmin(securityLakeClient);
    }

    this.logger.info(`Deregistered current Amazon Security Lake delegated administrator account ${currentAdmin}`);

    return this.generateStatusMessage(
      SecurityLakeOrganizationAdminActionType.DEREGISTER_DELEGATED_ADMIN,
      !!props.dryRun,
    );
  }

  /**
   * Deregisters the current delegated admin for Amazon Security Lake.
   *
   * @param client {@link SecurityLakeClient}
   * @param props {@link ISecurityLakeHandlerParameter}
   */
  private async deregisterDelegatedAdmin(client: SecurityLakeClient): Promise<void> {
    await throttlingBackOff(() => client.send(new DeregisterDataLakeDelegatedAdministratorCommand()));
  }

  /**
   * Helper function to generate status message.
   *
   * @param action SecurityLakeOrganizationAdminActionType
   * @param dryRun boolean
   * @returns status string
   */
  private generateStatusMessage(action: SecurityLakeOrganizationAdminActionType, dryRun: boolean): string {
    const dryRunPhrase = dryRun ? ' will be' : '';
    const status = dryRun
      ? '[DRY-RUN]: Amazon Security Lake de-register organization admin operation validated successfully (no actual changes were made).\nValidation: ✓ Successful\nStatus: '
      : 'Amazon Security Lake de-register Organization admin operation completed successfully.\nStatus: ';
    switch (action) {
      case SecurityLakeOrganizationAdminActionType.DEREGISTER_DELEGATED_ADMIN:
        return `${status}Amazon Security Lake Delegated admin account${dryRunPhrase} de-registered.`;
      case SecurityLakeOrganizationAdminActionType.DEREGISTER_SKIPPED:
        return `${status}Operation found Amazon Security Lake delegated administrator not set, de-registration${dryRunPhrase} skipped.`;
    }
  }
}
