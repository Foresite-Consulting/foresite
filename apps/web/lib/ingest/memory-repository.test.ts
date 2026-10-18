import { MemoryIngestRepository } from './memory-repository';
import { describeRepositoryContract } from './repository.contract';

describeRepositoryContract('memory', () => {
  const repository = new MemoryIngestRepository();
  return Promise.resolve({
    repository,
    seed: (device) => {
      repository.addDevice(device);
      return Promise.resolve();
    },
  });
});
