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
import { RegisterDataLakeDelegatedAdministratorCommand, SecurityLakeClient } from '@aws-sdk/client-securitylake';
import { throttlingBackOff } from '../../../common/throttle';
import { DeregisterOrganizationAdmin } from '../deregister-organization-admin';
import { getOrganizationDelegatedAdminAccountId } from '../../../common/resources';

/**
 * Enum for SetOrganizationAdmin operation action types.
 */
enum SecurityLakeOrganizationAdminActionType {
  SET_DELEGATED_ADMIN,
  UPDATE_DELEGATED_ADMIN,
  SKIP,
}

/**
 * RegisterOrganizationAdmin class to manage Amazon Security Lake
 * set organization Admin operation.
 */
export class RegisterOrganizationAdmin implements ISecurityLakeModuleAction {
  private logger = createLogger([path.parse(path.basename(__filename)).name]);
  /**
   * Handler function to manage Amazon Security Lake delegated admin.
   *
   * @param props {@link ISecurityLakeHandlerParameter}
   * @returns status string
   */
  public async handler(props: ISecurityLakeHandlerParameter): Promise<string> {
    if (!props.configuration?.delegatedAdminAccount) {
      throw new Error('Internal Error: Amazon Security Lake delegated Account Id not provided, operation aborted.');
    }
    const organizationClient = new OrganizationsClient({
      region: props.homeRegion,
      customUserAgent: props.solutionId,
      retryStrategy: setRetryStrategy(),
      credentials: props.credentials,
    });

    const currentAdmin = await getOrganizationDelegatedAdminAccountId(organizationClient, 'securitylake.amazonaws.com');

    const securityLakeClient = new SecurityLakeClient({
      region: props.homeRegion,
      customUserAgent: props.solutionId,
      retryStrategy: setRetryStrategy(),
      credentials: props.credentials,
    });

    const action = this.processSetOrganizationAdminAction(props.configuration.delegatedAdminAccount, currentAdmin);

    switch (action) {
      case SecurityLakeOrganizationAdminActionType.SKIP:
        this.logger.info(`Amazon Security Lake delegated admin already set to account ${currentAdmin}, exiting...`);
        break;
      case SecurityLakeOrganizationAdminActionType.UPDATE_DELEGATED_ADMIN:
        const deregisterStatus = new DeregisterOrganizationAdmin().handler(props);
        this.logger.info(
          `Amazon Security Lake De-register Organization Admin operation finished with status: ${deregisterStatus}`,
        );
        if (!props.dryRun) {
          this.registerDelegatedAdmin(securityLakeClient, props.configuration.delegatedAdminAccount);
        }
        this.logger.info(
          `Registered Amazon Security Lake delegated admin to account ${props.configuration.delegatedAdminAccount}`,
        );
        break;
      case SecurityLakeOrganizationAdminActionType.SET_DELEGATED_ADMIN:
        if (!props.dryRun) {
          this.registerDelegatedAdmin(securityLakeClient, props.configuration.delegatedAdminAccount);
        }
        this.logger.info(
          `Registered Amazon Security Lake delegated admin to account ${props.configuration.delegatedAdminAccount}`,
        );
    }

    return this.generateStatusMessage(action, !!props.dryRun, props.configuration.delegatedAdminAccount, currentAdmin);
  }

  /**
   * Register the delegated admin per configuration for Amazon Security Lake.
   *
   * @param client {@link SecurityLakeClient}
   * @param adminAccountId string
   */
  private async registerDelegatedAdmin(client: SecurityLakeClient, adminAccountId: string): Promise<void> {
    await throttlingBackOff(() =>
      client.send(
        new RegisterDataLakeDelegatedAdministratorCommand({
          accountId: adminAccountId,
        }),
      ),
    );
  }

  /**
   * Determine which action should the operation perform.
   *
   * @param newAdminAccount string
   * @param currentAccount string | undefined
   * @returns action SecurityLakeOrganizationAdminActionType
   */
  private processSetOrganizationAdminAction(
    newAdminAccount: string,
    currentAccount?: string,
  ): SecurityLakeOrganizationAdminActionType {
    if (!currentAccount) {
      return SecurityLakeOrganizationAdminActionType.SET_DELEGATED_ADMIN;
    } else if (currentAccount === newAdminAccount) {
      return SecurityLakeOrganizationAdminActionType.SKIP;
    } else {
      return SecurityLakeOrganizationAdminActionType.UPDATE_DELEGATED_ADMIN;
    }
  }

  /**
   * Helper function to generate status message.
   *
   * @param action SecurityLakeOrganizationAdminActionType
   * @param dryRun boolean
   * @param newAdminAccount string
   * @param currentAdminAccount string | undefined
   * @returns status string
   */
  private generateStatusMessage(
    action: SecurityLakeOrganizationAdminActionType,
    dryRun: boolean,
    newAdminAccount: string,
    currentAdminAccount?: string,
  ): string {
    const dryRunPhrase = dryRun ? ' will be' : '';
    const status = dryRun
      ? '[DRY-RUN]: AcceleratorSecurityLake SetOrganizationAdmin operation validated successfully (no actual changes were made).\nValidation: ✓ Successful\nStatus: '
      : 'AcceleratorSecurityLake SetOrganizationAdmin operation completed successfully.\nStatus: ';
    switch (action) {
      case SecurityLakeOrganizationAdminActionType.SET_DELEGATED_ADMIN:
        return `${status}Account ${newAdminAccount}${dryRunPhrase} registered as Amazon Security Lake Delegated Admin`;
      case SecurityLakeOrganizationAdminActionType.UPDATE_DELEGATED_ADMIN:
        return `${status}Amazon Security Lake delegated admin account${dryRunPhrase} changed from ${currentAdminAccount} to ${newAdminAccount}.`;
      case SecurityLakeOrganizationAdminActionType.SKIP:
        return `${status}Operation found current admin account is already ${currentAdminAccount}, set organization admin operation${dryRunPhrase} skipped.`;
    }
  }
}
