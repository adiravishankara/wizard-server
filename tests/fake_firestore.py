"""Tiny in-process stand-in for the google-cloud-firestore client surface we use."""
import copy


def _check_value(value, path, in_array=False):
    if isinstance(value, list):
        if in_array:
            raise TypeError(f"Firestore cannot store an array inside an array at {path}")
        for i, v in enumerate(value):
            _check_value(v, f"{path}[{i}]", in_array=True)
    elif isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise TypeError(f"Firestore map keys must be strings at {path}")
            _check_value(v, f"{path}.{k}")
    elif value is not None and not isinstance(value, (str, int, float, bool)):
        raise TypeError(f"Unsupported Firestore value {type(value).__name__} at {path}")


class _Snapshot:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data

    def to_dict(self):
        return copy.deepcopy(self._data)


class FakeDocument:
    def __init__(self, client, path):
        self._client = client
        self._path = path

    def set(self, data):
        _check_value(data, "/".join(self._path))
        self._client.writes += 1
        self._client.docs[self._path] = copy.deepcopy(data)

    def delete(self):
        self._client.docs.pop(self._path, None)

    def get(self):
        return _Snapshot(self._path[-1], self._client.docs.get(self._path))

    def collection(self, name):
        return FakeCollection(self._client, self._path + (name,))


class FakeCollection:
    def __init__(self, client, path):
        self._client = client
        self._path = path

    def document(self, doc_id):
        return FakeDocument(self._client, self._path + (doc_id,))

    def stream(self):
        depth = len(self._path) + 1
        for path, data in sorted(self._client.docs.items()):
            if len(path) == depth and path[:-1] == self._path:
                yield _Snapshot(path[-1], data)


class FakeFirestoreClient:
    def __init__(self):
        self.docs = {}
        self.writes = 0

    def collection(self, name):
        return FakeCollection(self, (name,))
