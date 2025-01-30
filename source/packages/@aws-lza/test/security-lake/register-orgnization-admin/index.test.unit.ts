import { describe, beforeEach, expect, test, jest } from '@jest/globals';

import { throttlingBackOff } from '../../../common/throttle';
import { RegisterOrganizationAdmin } from '../../../lib/security-lake/register-organization-admin/index';
import { DeregisterOrganizationAdmin } from '../../../lib/security-lake/deregister-organization-admin/index';
import { ISecurityLakeHandlerParameter, SecurityLakeModuleOperation } from '../../../interfaces/security-lake';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { SecurityLakeClient, RegisterDataLakeDelegatedAdministratorCommand } from '@aws-sdk/client-securitylake';
import { getOrganizationDelegatedAdminAccountId } from '../../../common/resources';

jest.mock('../../../common/throttle');
jest.mock('../../../common/resources');
jest.mock('@aws-sdk/client-organizations');
jest.mock('@aws-sdk/client-securitylake');
jest.mock('../../../lib/security-lake/deregister-organization-admin/index');

describe('SecurityLakeOrganizationAdmin', () => {
  const mockOrganizationClientSend = jest.fn();
  const mockSecurityLakeClientSend = jest.fn();
  const mockDeregisterHandler = jest.fn();
  let securityLakeAdmin: RegisterOrganizationAdmin;

  const baseProp: ISecurityLakeHandlerParameter = {
    operation: SecurityLakeModuleOperation.SET_ORGANIZATION_ADMIN,
    partition: 'aws',
    homeRegion: 'us-east-1',
    credentials: undefined,
    configuration: {
      delegatedAdminAccount: '111122223333',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    securityLakeAdmin = new RegisterOrganizationAdmin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (throttlingBackOff as jest.Mock<typeof throttlingBackOff>).mockImplementation(fn => fn());
    (OrganizationsClient as jest.Mock).mockImplementation(() => ({
      send: mockOrganizationClientSend,
    }));
    (SecurityLakeClient as jest.Mock).mockImplementation(() => ({
      send: mockSecurityLakeClientSend,
    }));
    (DeregisterOrganizationAdmin as jest.Mock).mockImplementation(() => ({
      handler: mockDeregisterHandler,
    }));
  });

  describe('Non-Dry Run Mode', () => {
    test('should SET_DELEGATED_ADMIN when no current admin exists', async () => {
      (getOrganizationDelegatedAdminAccountId as jest.Mock).mockReturnValueOnce(undefined);

      const result = await securityLakeAdmin.handler({ ...baseProp, solutionId: 'AwsSolution/SO0199/1' });

      expect(result).toContain('Account 111122223333 registered as Amazon Security Lake Delegated Admin');
      expect(mockSecurityLakeClientSend).toHaveBeenCalledWith(
        expect.any(RegisterDataLakeDelegatedAdministratorCommand),
      );
    });

    test('should UPDATE_DELEGATED_ADMIN when current admin is different', async () => {
      (getOrganizationDelegatedAdminAccountId as jest.Mock).mockReturnValueOnce('999988887777');

      const result = await securityLakeAdmin.handler(baseProp);

      expect(result).toContain(
        'Amazon Security Lake delegated admin account changed from 999988887777 to 111122223333',
      );
      expect(mockDeregisterHandler).toHaveBeenCalled();
      expect(mockSecurityLakeClientSend).toHaveBeenCalledWith(
        expect.any(RegisterDataLakeDelegatedAdministratorCommand),
      );
    });

    test('should SKIP when current admin is the same as new admin', async () => {
      (getOrganizationDelegatedAdminAccountId as jest.Mock).mockReturnValueOnce('111122223333');

      const result = await securityLakeAdmin.handler(baseProp);

      expect(result).toContain(
        'Operation found current admin account is already 111122223333, set organization admin operation skipped',
      );
      expect(mockSecurityLakeClientSend).not.toHaveBeenCalled();
    });
  });

  describe('Dry Run Mode', () => {
    const dryRunProps = { ...baseProp, dryRun: true };

    test('should throw when delegated account id not provided', async () => {
      await expect(securityLakeAdmin.handler({ ...dryRunProps, configuration: undefined })).rejects.toThrow(
        'Internal Error: Amazon Security Lake delegated Account Id not provided, operation aborted.',
      );
    });

    test('should validate SET_DELEGATED_ADMIN when no current admin exists', async () => {
      (getOrganizationDelegatedAdminAccountId as jest.Mock).mockReturnValueOnce(undefined);

      const result = await securityLakeAdmin.handler(dryRunProps);

      expect(result).toContain('[DRY-RUN]');
      expect(result).toContain('Account 111122223333 will be registered as Amazon Security Lake Delegated Admin');
      expect(mockSecurityLakeClientSend).not.toHaveBeenCalled();
    });

    test('should validate UPDATE_DELEGATED_ADMIN when current admin is different', async () => {
      (getOrganizationDelegatedAdminAccountId as jest.Mock).mockReturnValueOnce('999988887777');

      const result = await securityLakeAdmin.handler(dryRunProps);

      expect(result).toContain('[DRY-RUN]');
      expect(result).toContain(
        'Amazon Security Lake delegated admin account will be changed from 999988887777 to 111122223333',
      );
      expect(mockSecurityLakeClientSend).not.toHaveBeenCalled();
    });

    test('should validate SKIP when current admin is the same as new admin', async () => {
      (getOrganizationDelegatedAdminAccountId as jest.Mock).mockReturnValueOnce('111122223333');

      const result = await securityLakeAdmin.handler(dryRunProps);

      expect(result).toContain('[DRY-RUN]');
      expect(result).toContain(
        'Operation found current admin account is already 111122223333, set organization admin operation will be skipped',
      );
      expect(mockSecurityLakeClientSend).not.toHaveBeenCalled();
    });
  });
});
