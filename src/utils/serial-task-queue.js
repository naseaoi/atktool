function createSerialTaskQueue() {
  let tail = Promise.resolve();

  return function enqueue(task) {
    const result = tail.then(task, task);
    tail = result.catch(() => {});
    return result;
  };
}

module.exports = {
  createSerialTaskQueue,
};
