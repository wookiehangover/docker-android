import json
import logging
import os
import signal
import time

from abc import ABC, abstractmethod
from enum import Enum

from helper import get_env_value_or_raise
from constants import DEVICE, ENV


class DeviceType(Enum):
    EMULATOR = "emulator"
    GENY_SAAS = "geny_saas"
    GENY_AWS = "geny_aws"


class Device(ABC):

    def __init__(self) -> None:
        self.logger = logging.getLogger(self.__class__.__name__)
        self.device_type = None
        self.interval_waiting = int(os.getenv(ENV.DEVICE_INTERVAL_WAITING, 2))
        signal.signal(signal.SIGTERM, self.tear_down)

    def set_status(self, current_status) -> None:
        bashrc_file = f"{os.getenv(ENV.WORK_PATH)}/device_status"
        with open(bashrc_file, "w+") as bf:
            bf.write(current_status)
        # It won't work using docker exec
        # os.environ[constants.ENV_DEVICE_STATUS] = current_status

    def create(self) -> None:
        self.set_status(DEVICE.STATUS_CREATING)

    def start(self) -> None:
        self.set_status(DEVICE.STATUS_STARTING)

    def wait_until_ready(self) -> None:
        self.set_status(DEVICE.STATUS_BOOTING)

    def reconfigure(self) -> None:
        self.set_status(DEVICE.STATUS_RECONFIGURING)

    def keep_alive(self) -> None:
        self.set_status(DEVICE.STATUS_READY)
        self.logger.warning(f"{self.device_type} process will be kept alive to be able to get sigterm signal...")
        while True:
            time.sleep(2)

    @abstractmethod
    def tear_down(self, *args) -> None:
        pass


class Genymotion(Device):
    def __init__(self) -> None:
        super().__init__()
        self.logger = logging.getLogger(self.__class__.__name__)

    def get_data_from_template(self, filename: str) -> dict:
        path_template_json = os.path.join(get_env_value_or_raise(ENV.GENYMOTION_TEMPLATE_PATH), filename)
        data = {}
        if os.path.isfile(path_template_json):
            try:
                self.logger.info(path_template_json)
                with open(path_template_json, "r") as f:
                    data = json.load(f)
            except FileNotFoundError as fnf:
                self.shutdown_and_logout()
                self.logger.error(f"File cannot be found: {fnf}")
            except json.JSONDecodeError as jde:
                self.shutdown_and_logout()
                self.logger.error(f"Error Decoding Json: {jde}")
            except Exception as e:
                self.shutdown_and_logout()
                self.logger.error(e)
        else:
            self.shutdown_and_logout()
            raise RuntimeError(f"'{path_template_json}' cannot be found!")
        return data

    @abstractmethod
    def login(self) -> None:
        pass

    def create(self) -> None:
        super().create()
        self.login()

    @abstractmethod
    def shutdown_and_logout(self) -> None:
        pass

    def tear_down(self, *args) -> None:
        self.shutdown_and_logout()
